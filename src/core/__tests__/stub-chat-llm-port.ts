/**
 * src/core/__tests__/stub-chat-llm-port.ts — T-0359 (E17) deterministic chat stub.
 *
 * ZERO NETWORK / ZERO COST.
 * This stub implements both LlmPort.complete() (delegated to StubLlmPort) and
 * LlmPort.chat() (deterministic fixture — no network call, no LLM key needed).
 *
 * SAFETY RULE: even if OPENAI_API_KEY or ANTHROPIC_API_KEY is set in the
 * environment, this stub NEVER makes a network call. It intentionally ignores
 * all env keys. The fixture output is 100% deterministic from the mode config.
 *
 * USAGE (tests):
 *   const stub = new StubChatLlmPort();               // default: succeed mode
 *   const stub = new StubChatLlmPort({ mode: 'error' }); // throws on chat()
 *   const stub = new StubChatLlmPort({ mode: 'dormant' }); // throws LlmDormantError
 *   const stub = new StubChatLlmPort({ fixedText: 'custom reply' });
 *   stub.chatCalls // array of all chat() invocations for assertions
 */

import type {
  LlmPort,
  LlmRequest,
  LlmResult,
  ChatLlmRequest,
  ChatLlmResult,
} from "../llm-port.js";
import { LlmDormantError } from "../llm-port.js";
import { StubLlmPort } from "./stub-llm-port.js";

// ---------------------------------------------------------------------------
// Fixed deterministic chat fixtures (no reasoning, no secrets).
// ---------------------------------------------------------------------------

/**
 * Default deterministic assistant reply for the 'succeed' mode.
 * Simulates an analyst response with a summary paragraph.
 */
const DEFAULT_CHAT_TEXT =
  "Понял задачу. Могу помочь с анализом или настройкой — уточните, что именно нужно сделать.";

// ---------------------------------------------------------------------------
// StubChatLlmPort modes (superset of StubLlmPort modes).
// ---------------------------------------------------------------------------

export type StubChatMode =
  | "succeed"   // returns DEFAULT_CHAT_TEXT (or fixedText)
  | "error"     // throws generic Error on chat()
  | "dormant";  // throws LlmDormantError on chat()

export interface StubChatLlmPortConfig {
  /** Behaviour for chat() calls. Default: 'succeed'. */
  readonly mode?: StubChatMode;
  /** Override the fixed reply text (mode='succeed' only). */
  readonly fixedText?: string;
  /** Record chat calls for assertions (always recorded). */
  readonly recordCalls?: boolean;
}

/**
 * Deterministic dual-port stub implementing the full LlmPort interface.
 *
 * - complete() is delegated to StubLlmPort (preserves existing test paths).
 * - chat() is a new deterministic stub (zero network, returns fixture text).
 *
 * NF-6 invariant: same config + same input → same output, always.
 * Env-key safety: intentionally ignores all API key env vars — does NOT call
 * the network even when a real key is present in the environment.
 */
export class StubChatLlmPort implements LlmPort {
  private readonly mode: StubChatMode;
  private readonly fixedText: string;
  private readonly _completeSub: StubLlmPort;

  /** Recorded chat() invocations — inspect in tests. */
  readonly chatCalls: ChatLlmRequest[] = [];

  constructor(config: StubChatLlmPortConfig = {}) {
    this.mode = config.mode ?? "succeed";
    this.fixedText = config.fixedText ?? DEFAULT_CHAT_TEXT;
    // Wire StubLlmPort for the complete() path (same deterministic behavior).
    this._completeSub = new StubLlmPort({ recordCalls: config.recordCalls });
  }

  // ---------------------------------------------------------------------------
  // LlmPort.complete() — delegated to existing StubLlmPort
  // ---------------------------------------------------------------------------

  complete(req: LlmRequest): Promise<LlmResult> {
    return this._completeSub.complete(req);
  }

  // ---------------------------------------------------------------------------
  // LlmPort.chat() — deterministic, zero network
  // ---------------------------------------------------------------------------

  async chat(req: ChatLlmRequest): Promise<ChatLlmResult> {
    // SAFETY: we intentionally do NOT read process.env here, even to check for
    // a key. This stub NEVER makes a network call regardless of env state.

    this.chatCalls.push(req);

    switch (this.mode) {
      case "dormant":
        throw new LlmDormantError("stub: llm dormant (mode=dormant)");

      case "error":
        throw new Error("stub: llm_error on chat (simulated)");

      case "succeed":
      default:
        return {
          text: this.fixedText,
          // No tool calls in stub mode (Wave 2 tools are tested separately).
          toolCalls: undefined,
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150,
          },
        };
    }
  }
}
