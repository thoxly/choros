/**
 * src/adapters/openai-llm-port.ts — T-0233 Production LlmPort adapter (OpenAI-compatible).
 *
 * Stage-deploy: this file MUST NOT be imported by src/core/** or
 * src/runtime/legal-precheck/** — it carries SDK/fetch/secret paths.
 * It is wired ONLY at the composition root (src/main.ts / deploy config)
 * when deps.liveEnabled=true and agent_card.llm_* are configured.
 *
 * RL-3 custody (T-0025, AC-13):
 *   - LLM secret is resolved via SecretResolverPort (opaque handle),
 *     NEVER stored raw in a column/log/audit/response/exception.
 *   - redactHandle() is used for any logging of the handle reference.
 *   - validateSecretHandleShape() is called before use.
 *
 * Fitness: precheck-secret-custody.sh verifies no llm_secret_handle raw
 * in logs/audit/response on the runtime path.
 */

import https from "node:https";
import type { LlmPort, LlmRequest, LlmResult, PrecheckAnswer } from "../core/llm-port.js";
import { SecretResolverPort, validateSecretHandleShape, redactHandle } from "../core/secret-handle-validator.js";

// ---------------------------------------------------------------------------
// OpenAI chat completion response types (minimal, zero-dep).
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  response_format?: { type: "json_object" };
  temperature?: number;
}

interface ChatCompletionChoice {
  message: { role: string; content: string };
  finish_reason: string | null;
}

interface ChatCompletionResponse {
  choices: ChatCompletionChoice[];
}

// ---------------------------------------------------------------------------
// OpenAILlmPort — production adapter.
// ---------------------------------------------------------------------------

export interface OpenAILlmPortConfig {
  /** OpenAI-compatible endpoint (e.g. https://api.openai.com/v1). */
  readonly endpoint: string;
  /** Model name (e.g. gpt-4o-mini). */
  readonly model: string;
  /** Opaque handle to the LLM API key — resolved via secretResolver (RL-3). */
  readonly secretHandle: string;
  /** Tenant context for secret resolution. */
  readonly tenantId: string;
  /** Secret resolver port (T-0025). */
  readonly secretResolver: SecretResolverPort;
  /** Request timeout in ms (default 30000). */
  readonly timeoutMs?: number;
}

/**
 * Production OpenAI-compatible LlmPort. Wired at composition root only.
 * The core and runtime paths NEVER import this file.
 */
export class OpenAILlmPort implements LlmPort {
  private readonly config: Required<OpenAILlmPortConfig>;

  constructor(config: OpenAILlmPortConfig) {
    // RL-3: validate the handle shape — not a raw key.
    const verdict = validateSecretHandleShape(config.secretHandle);
    if (!verdict.ok) {
      throw new Error(
        `OpenAILlmPort: invalid secret handle (${verdict.reason}); ` +
        `use an opaque vault/env reference, not a raw key. ` +
        `Handle (redacted): ${redactHandle(config.secretHandle)}`,
      );
    }
    this.config = {
      endpoint: config.endpoint,
      model: config.model,
      secretHandle: config.secretHandle,
      tenantId: config.tenantId,
      secretResolver: config.secretResolver,
      timeoutMs: config.timeoutMs ?? 30_000,
    };
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    // RL-3: resolve the secret at call time, via SecretResolverPort.
    const apiKey = await this.config.secretResolver.resolveSecret(
      this.config.secretHandle,
      { tenantId: this.config.tenantId },
    );

    const systemPrompt = [
      req.instruction,
      `\nAnswer strictly in this JSON format matching the answer form "${req.answerForm}":`,
      `{"answerForm":"${req.answerForm}","redFlags":[{"clause":"...","risk":"...","severity":"low|med|high"}],"summary":"..."}`,
      `\nDeal context: amount=${req.dealContext.amount}, kind=${req.dealContext.kind}, direction=${req.dealContext.direction}`,
    ].join("\n");

    const body: ChatCompletionRequest = {
      model: this.config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: req.document },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    };

    const raw = await this._post(apiKey, body);

    const content = raw.choices[0]?.message?.content ?? "{}";
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      throw new Error(`OpenAILlmPort: invalid JSON response from model`);
    }

    // Extract confidence: use a top-level confidence field if present, else default 0.8.
    const confidence =
      typeof parsed["confidence"] === "number"
        ? (parsed["confidence"] as number)
        : 0.8;

    // D-139: extract reasoning (internal only — will be masked in audit, never egressed).
    const reasoning =
      typeof parsed["reasoning"] === "string"
        ? (parsed["reasoning"] as string)
        : undefined;

    // Build the safe PrecheckAnswer (no reasoning field).
    const answer: PrecheckAnswer = {
      answerForm: typeof parsed["answerForm"] === "string" ? (parsed["answerForm"] as string) : req.answerForm,
      redFlags: Array.isArray(parsed["redFlags"])
        ? (parsed["redFlags"] as Array<{ clause: string; risk: string; severity: string }>).map((f) => ({
            clause: String(f.clause ?? ""),
            risk: String(f.risk ?? ""),
            severity: (["low", "med", "high"].includes(f.severity) ? f.severity : "low") as "low" | "med" | "high",
          }))
        : [],
      summary: typeof parsed["summary"] === "string" ? (parsed["summary"] as string) : "",
    };

    return { confidence, answer, reasoning };
  }

  /** Make a POST to the OpenAI chat completions endpoint. */
  private _post(apiKey: string, body: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    return new Promise<ChatCompletionResponse>((resolve, reject) => {
      const payload = JSON.stringify(body);
      const url = new URL(`${this.config.endpoint}/chat/completions`);

      const options: https.RequestOptions = {
        method: "POST",
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          // RL-3: apiKey is resolved from SecretResolverPort, not stored raw.
          "Authorization": `Bearer ${apiKey}`,
        },
        timeout: this.config.timeoutMs,
      };

      const request = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            const parsed = JSON.parse(text) as ChatCompletionResponse;
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`OpenAI API error ${res.statusCode}: ${text}`));
            } else {
              resolve(parsed);
            }
          } catch {
            reject(new Error(`OpenAI API non-JSON response: ${text.slice(0, 200)}`));
          }
        });
      });

      request.on("timeout", () => {
        request.destroy();
        reject(new Error("timeout: OpenAI request exceeded " + this.config.timeoutMs + "ms"));
      });
      request.on("error", (err) => reject(err));

      request.write(payload);
      request.end();
    });
  }
}
