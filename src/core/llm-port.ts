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
 * the end user (see ASSISTANT_LLM_UNAVAILABLE_MESSAGE_ADMIN/_NON_ADMIN,
 * assistant-messages.ts — T-0595 split the single constant by caller admin
 * status).
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
// T-0600: provider-auth-fail classifier + canonical error text.
//
// A live acceptance run surfaced a SECOND honesty defect distinct from the
// dormant/adapter-failure split above: two call sites (assistant-configurator.ts
// ::runConfiguratorLoop, process-gen-loop.ts::runProcessGenLoop) catch a
// thrown LlmUnavailableError LOCALLY (never reaching classifyLlmUnavailability/
// the HTTP layer's honest-503 path) and interpolated err.message VERBATIM into
// user-visible chat text. For a provider 4xx, src/adapters/openai-llm-port.ts's
// `_post` embeds the provider's FULL raw response body in that message
// (`OpenAI API error ${statusCode}: ${text}`) — so a raw, unredacted vendor
// JSON blob (e.g. `{"error":{"message":"Incorrect API key...",...}}`) was
// reaching the end user. That raw body is exactly the kind of dev-jargon/
// internal-detail leak assistant-llm-message-jargon.sh already polices for
// the T-0573 canonical constants — this closes the SAME class of leak at the
// two places that bypass that machinery entirely.
//
// isProviderAuthFailure classifies BY THE MESSAGE PREFIX OUR OWN ADAPTER
// CONTROLS ("OpenAI API error 401/403:") — never by parsing the provider's
// arbitrary JSON body, which is not a stable contract across providers/
// endpoints. canonicalizeLlmError turns ANY caught LLM error into a fixed,
// jargon-free Russian sentence — the raw message is NEVER echoed, regardless
// of classification outcome. The full original error is the CALLER's
// responsibility to log server-side (console.error) before discarding it;
// this function only ever returns the safe, canonical text.
// ---------------------------------------------------------------------------

/**
 * T-0600: true when `err` is an `LlmUnavailableError` whose message shows the
 * adapter's OWN "OpenAI API error 401/403: ..." prefix (invalid/revoked
 * provider key) — as opposed to a timeout, network error, malformed
 * response, or a different HTTP status. Matches on the prefix our adapter
 * writes, never on the provider's raw body content.
 */
export function isProviderAuthFailure(err: unknown): boolean {
  if (!(err instanceof LlmUnavailableError)) return false;
  return /OpenAI API error (401|403):/.test(err.message);
}

/**
 * T-0600 (F4/F5): convert a caught LLM error into a canonical, jargon-free,
 * Russian, human-readable message — NEVER echoing the raw err.message (which
 * may embed a provider's raw JSON response body, an internal exception
 * string, or other dev-facing detail). Use this at any call site that
 * currently (or might) interpolate a caught LLM error into user-visible
 * text; the honest-503 path (respondLlmUnavailable, src/http/assistant.ts)
 * does NOT need this helper — it already ignores err.message entirely and
 * uses the T-0573/T-0595 canonical ASSISTANT_LLM_UNAVAILABLE_MESSAGE_*
 * constants unconditionally.
 *
 * The full original error is NOT logged by this function — callers must log
 * it themselves (e.g. `console.error`) BEFORE discarding it, so operators
 * retain full diagnostic detail server-side while the user only ever sees
 * the safe canonical sentence below.
 */
export function canonicalizeLlmError(err: unknown): string {
  if (isProviderAuthFailure(err)) {
    return "Ключ LLM отклонён провайдером. Проверьте или замените ключ в LLM-соединениях.";
  }
  if (err instanceof LlmDormantError) {
    return "LLM-ключ не подключён. Настройте профиль ассистента в LLM-соединениях.";
  }
  // Generic adapter failure (timeout / network / malformed response / any
  // other provider HTTP status) — same honest, human framing; no status
  // code, no raw body, no "port"/"adapter"/technical jargon.
  return "Не удалось обработать запрос из-за проблемы с подключением к LLM. Попробуйте ещё раз позже.";
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
