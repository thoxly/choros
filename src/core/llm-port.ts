/**
 * src/core/llm-port.ts — T-0233 LlmPort injectable type + dormant stub
 *
 * PURE: no pg / node:http / https / net / fetch / child_process / process.env.
 * Pattern mirrors SecretResolverPort in secret-handle-validator.ts — the core
 * owns the type declaration; production adapters live in src/adapters/.
 *
 * D-139 SEPARATION: LlmResult carries `answer` (safe, external) vs `reasoning?`
 * (internal-only; must ONLY appear in appendAuditEvent payload, never in egress).
 *
 * FF-LP-1: LlmPort is injectable via deps (like ResolverDeps/AncestryOracle).
 * FF-LP-3: dormantLlmPort throws on any complete() call (fail-closed default).
 * FF-LP-9: this module has zero IO imports — verified by no-env-in-core.sh.
 */

// ---------------------------------------------------------------------------
// PrecheckAnswer — form-bound answer (D-139: NO reasoning fields).
// Lives here so LlmResult can reference it without a circular dep.
// ---------------------------------------------------------------------------

/** One identified risk clause in the contract. */
export interface RedFlag {
  readonly clause: string;
  readonly risk: string;
  readonly severity: "low" | "med" | "high";
}

/**
 * Structured answer in the form of agent_instruction.answerForm (T-0123).
 *
 * D-139 INVARIANT: this type MUST NOT contain reasoning / trace / raw /
 * chainOfThought fields. The tsc structural check + precheck-no-reasoning-egress.sh
 * enforce this. Only answer (safe summary + flags) goes external.
 */
export interface PrecheckAnswer {
  /** Echo of the applied agent_instruction.answerForm (AC-10). */
  readonly answerForm: string;
  /** Identified risk clauses (may be empty on a clean contract). */
  readonly redFlags: readonly RedFlag[];
  /** Safe summary (NOT reasoning — no chain-of-thought verbatim). */
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// LlmRequest — what the orchestrator sends into the port.
// Raw secrets are NEVER present here; they live in the adapter only (RL-3).
// ---------------------------------------------------------------------------

/**
 * Request payload sent to the LLM via the port.
 * Masking D-139: contains instruction+document+form — NOT a raw secret.
 * The secret is resolved in the production adapter via SecretResolverPort.
 */
export interface LlmRequest {
  /** System instruction for the skill (from agent_instruction.instructionText). */
  readonly instruction: string;
  /** Contract body + transaction context (deal amount/kind/direction). */
  readonly document: string;
  /** Transaction context structured. */
  readonly dealContext: {
    readonly amount: number;
    readonly kind: string;
    readonly direction: string;
  };
  /** Answer form code from agent_instruction.answerForm (T-0123). */
  readonly answerForm: string;
}

// ---------------------------------------------------------------------------
// LlmResult — structured outcome. D-139: answer vs reasoning separated.
// ---------------------------------------------------------------------------

/**
 * Structured result from a port.complete() call.
 *
 * D-139 SPLIT:
 *   - `answer`    = safe external form (PrecheckAnswer) — may flow to process/user.
 *   - `reasoning` = INTERNAL ONLY; written ONLY to appendAuditEvent payload under
 *                   T-0139-masking. MUST NOT appear in PrecheckOutcome/res.json/egress.
 */
export interface LlmResult {
  /** Model self-confidence [0,1] — B.5 secondary signal (T-0220 §5.1). */
  readonly confidence: number;
  /** Structured answer in answerForm shape. Safe to surface externally. */
  readonly answer: PrecheckAnswer;
  /** Raw reasoning trace — INTERNAL ONLY. Mask before writing to audit (T-0139). */
  readonly reasoning?: string;
}

// ---------------------------------------------------------------------------
// T-0359 (E17) — General chat shapes (additive, does NOT break complete()).
// ---------------------------------------------------------------------------

/**
 * One turn in a chat conversation.
 * "user" = the human / calling code; "assistant" = model reply.
 */
export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/**
 * One tool call returned by the model (optional, for agentic paths).
 */
export interface ChatToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string; // JSON-serialized
}

/**
 * Chat request sent to the LLM via the port.
 * D-139: NO raw secrets here; resolved in the adapter via SecretResolverPort.
 */
export interface ChatLlmRequest {
  /** System prompt (persona / task framing). */
  readonly system: string;
  /** Conversation history + new user turn (in order). */
  readonly messages: ChatMessage[];
  /**
   * Optional tool declarations (for the configurator / analyst to call
   * choros primitives). Each item is an OpenAI-compatible tool object.
   * Omit when pure text generation is desired.
   */
  readonly tools?: readonly unknown[];
}

/**
 * Structured result from a port.chat() call.
 *
 * D-139 SPLIT (mirrors LlmResult):
 *   - `text`      = assistant text reply — safe to surface to the user.
 *   - `toolCalls` = optional model-requested tool invocations.
 *   - `usage`     = token counts for budget tracking.
 *   Reasoning / chain-of-thought MUST NOT appear in any exported field —
 *   audit-only if the adapter surfaces it.
 */
export interface ChatLlmResult {
  /** Assistant text reply (empty string when toolCalls is non-empty). */
  readonly text: string;
  /** Model-requested tool calls, if any. */
  readonly toolCalls?: readonly ChatToolCall[];
  /** Token usage for budget accounting (optional — provider may omit). */
  readonly usage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

// ---------------------------------------------------------------------------
// LlmPort — the injectable interface (pattern: SecretResolverPort).
// ---------------------------------------------------------------------------

/**
 * The injectable LLM port. One method.
 *
 * Production adapter  → src/adapters/openai-llm-port.ts (SDK, secret, fetch).
 * Test stub           → src/core/__tests__/stub-llm-port.ts (deterministic, zero net).
 * Dormant default     → dormantLlmPort below (throws on any call).
 *
 * The core motor and orchestrator depend ONLY on this interface — never on a
 * concrete SDK. Wiring lives in the composition root / deploy config.
 */
export interface LlmPort {
  /**
   * Issue one LLM completion. Returns a structured LlmResult.
   * Throws LlmDormantError when called on dormantLlmPort (fail-closed).
   */
  complete(req: LlmRequest): Promise<LlmResult>;

  /**
   * T-0359 (E17): General chat completion (multi-turn, optional tool use).
   * Returns a ChatLlmResult.
   * Throws LlmDormantError when called on dormantLlmPort (fail-closed).
   */
  chat(req: ChatLlmRequest): Promise<ChatLlmResult>;
}

// ---------------------------------------------------------------------------
// LlmDormantError — thrown by dormantLlmPort (classifyOutcome → defer/fail).
// ---------------------------------------------------------------------------

/**
 * Thrown by dormantLlmPort.complete(). The orchestrator catches this and
 * maps it to a defer-to-human (signal="dormant") or fail-closed outcome —
 * NEVER to proceed (INV-DEFAULT).
 */
export class LlmDormantError extends Error {
  readonly cause = "dormant" as const;

  constructor(message = "llm runtime dormant") {
    super(message);
    this.name = "LlmDormantError";
  }
}

// ---------------------------------------------------------------------------
// LlmUnavailableError — T-0573 (ADR-T0573 §2.2 B1): thrown by a production
// adapter (e.g. OpenAILlmPort) when the CONFIGURED provider/key/endpoint is
// unreachable or rejects the call (invalid secret handle, non-JSON response,
// HTTP >=400, timeout, network error). This is DIFFERENT from LlmDormantError
// (no config at all) — here a config EXISTS but calling it failed. Both are
// classified as "unavailable" by classifyLlmUnavailability below, so the HTTP
// layer can answer both with the SAME honest 503, never a raw INTERNAL.
// ---------------------------------------------------------------------------

/**
 * Thrown by a production LlmPort adapter when a CONFIGURED provider call
 * fails (bad key/handle, non-JSON response, HTTP error, timeout, network).
 * The original failure is preserved as `cause` for logs — NEVER surfaced to
 * the end user (see ASSISTANT_LLM_UNAVAILABLE_MESSAGE, assistant-messages.ts).
 */
export class LlmUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmUnavailableError";
  }
}

/**
 * T-0573 (ADR-T0573 §2.2 B1): classify an error caught around ctx.llm.chat()/
 * complete() as "unavailable" (honest 503, no LLM reachable) or `null` (NOT an
 * LLM-availability problem — a real bug, must fall through to INTERNAL, never
 * masked as "no key").
 *
 * Classification is BY TYPE, never by message string (N4/AC-7: no dev-jargon
 * text-sniffing, robust to adapter wording changes):
 *   - err instanceof LlmDormantError    → "unavailable" (no config at all).
 *   - err instanceof LlmUnavailableError → "unavailable" (config exists, call failed).
 *   - anything else                     → null (do not hide real bugs).
 */
export function classifyLlmUnavailability(err: unknown): "unavailable" | null {
  if (err instanceof LlmDormantError) return "unavailable";
  if (err instanceof LlmUnavailableError) return "unavailable";
  return null;
}

// ---------------------------------------------------------------------------
// dormantLlmPort — the fail-closed default (FR-7 / AC-4, three-lock §6).
// ---------------------------------------------------------------------------

/**
 * The default LlmPort used when live LLM is not configured.
 * complete() and chat() always throw LlmDormantError — structurally impossible
 * to make a network call through this port. This is lock #3 of the dormant gate.
 *
 * Lock #1: agent_card.llm_* NULL (DB config, migrations/032).
 * Lock #2: deps.liveEnabled=false at composition root.
 * Lock #3: this port throws — no network path exists.
 */
export const dormantLlmPort: LlmPort = {
  complete(_req: LlmRequest): Promise<LlmResult> {
    throw new LlmDormantError("llm runtime dormant — configure agent_card.llm_* to enable");
  },
  chat(_req: ChatLlmRequest): Promise<ChatLlmResult> {
    return Promise.reject(new LlmDormantError("llm runtime dormant — configure agent_card.llm_* to enable"));
  },
};
