/**
 * src/core/process-gen-loop.ts — T-0464 [D8-G3]: free process generation loop.
 *
 * Spec: docs/specs/text-first-solution-builder.spec.md §3.4.
 *
 *   «Бот эмитит BPMN-черновик свободной топологии → цикл "сгенерил → bpmn-linter /
 *    гард мёртвой ветки → почини по тексту ошибки → повтор" (ограниченное число
 *    попыток). Условия шлюзов и роли заземлены на реальные поля/роли (создал →
 *    ссылается; нет → каскад). Ревью — в Модельере.»
 *
 * THE LOOP
 *   1. GENERATE — ask the configurator bot (LlmPort.chat) to emit a free-topology
 *      BPMN draft from the user's text description.
 *   2. VALIDATE — validateGeneratedProcess() runs the EXISTING linters (parallel
 *      T-0456, timer T-0458, lane→role, message rule T-0459 once merged) via lintBpmn,
 *      PLUS the NEW dead-branch/reachability guard, PLUS grounding (gateway conditions
 *      + lane roles vs the real fields/roles).
 *   3a. LINT ERRORS  → feed the error TEXT back to the bot → retry, bounded by
 *       MAX_GEN_ATTEMPTS (default 3). On exhaustion: surface HONESTLY — return a
 *       failed outcome with the last errors; DO NOT emit a broken process.
 *   3b. GROUNDING GAP → the referenced field/app/role does not exist. The loop does
 *       NOT just re-prompt: it surfaces a CASCADE/ASK outcome (the T-0463
 *       relate_application primitive resolves missing apps; a missing field/role is
 *       asked). This is distinct from a lint failure.
 *   4. SUCCESS — a grounded, lint-clean draft → return a DRAFT outcome carrying the
 *      modeler deep-link. The draft is NOT auto-published; the human reviews + promotes
 *      in the Modeler (promote stays human-gated).
 *
 * PURITY (CI: no-env-in-core)
 *   PURE: no pg, no http, no fetch, no process.env, no child_process. The bot is the
 *   injected LlmPort. The generated draft is returned as a PLAN; the HTTP layer
 *   persists it as a process_definition row with status='draft' (the SAME draft path
 *   the visual modeler / configurator writes — co-equal one model) and builds the
 *   real deep-link. This keeps the loop testable at $0 with a scripted chat stub.
 */

import type { LlmPort, ChatLlmRequest, ChatMessage } from "./llm-port.js";
import { LlmDormantError } from "./llm-port.js";
import {
  validateGeneratedProcess,
  formatLintFeedback,
  formatGroundingFeedback,
  type GroundingContext,
  type GroundingGap,
  type GenValidationResult,
} from "./process-gen-validator.js";

// ---------------------------------------------------------------------------
// Bounded attempt limit
// ---------------------------------------------------------------------------

/**
 * Maximum generate→validate→repair attempts before surfacing failure honestly.
 * Spec §3.4: "ограниченное число попыток" (e.g. 3). After this many failed
 * validations we STOP and report — we never emit a broken process.
 */
export const MAX_GEN_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Everything the loop needs to generate + validate + ground one process.
 * Pure inputs — the HTTP layer assembles these from the request + tenant DB.
 */
export interface ProcessGenRequest {
  /** The user's free-text description of the process they want. */
  readonly description: string;
  /** The injected configurator bot (LlmPort.chat). */
  readonly llm: LlmPort;
  /** System prompt for the generation persona (caller may override). */
  readonly systemPrompt: string;
  /** Grounding context: the real field keys + role slugs to ground against. */
  readonly grounding: GroundingContext;
  /** Process key (slug) the draft will be saved under (for the deep-link). */
  readonly processKey: string;
  /** Human display name for the process. */
  readonly processName: string;
  /** Override the attempt cap (tests). Default MAX_GEN_ATTEMPTS. */
  readonly maxAttempts?: number;
}

// ---------------------------------------------------------------------------
// Outcomes — discriminated union. Every terminal state is explicit & honest.
// ---------------------------------------------------------------------------

/**
 * SUCCESS: a grounded, lint-clean draft converged. The HTTP layer persists it as
 * status='draft' and the human reviews/promotes in the Modeler. NEVER auto-published.
 */
export interface ProcessGenDraftReady {
  readonly status: "draft_ready";
  /** The validated BPMN XML to persist as a draft. */
  readonly bpmnXml: string;
  /** The process key / name the draft is saved under. */
  readonly processKey: string;
  readonly processName: string;
  /** How many generate attempts it took (1 = first try). */
  readonly attempts: number;
  /** Human-readable summary (changelog) — safe to surface. */
  readonly summary: string;
}

/**
 * GROUNDING GAP: the draft is structurally fine (or close) but references a field/
 * app/role that does NOT exist. The loop surfaces this so the caller cascades
 * (create the missing app via relate_application) or asks the human. NOT auto-emitted.
 */
export interface ProcessGenNeedsGrounding {
  readonly status: "needs_grounding";
  /** The gaps to resolve (missing fields / roles). */
  readonly gaps: readonly GroundingGap[];
  /** Human-readable question/explanation for cascade-or-ask. */
  readonly message: string;
  /** The last draft (kept so a follow-up turn can patch it after cascade). */
  readonly lastDraftXml: string | null;
}

/**
 * FAILED (attempt-limit exhausted): the bot could not produce a lint-clean draft
 * within maxAttempts. Surfaced HONESTLY — NO broken process is emitted. The last
 * errors are returned so the human sees why.
 */
export interface ProcessGenExhausted {
  readonly status: "exhausted";
  /** How many attempts were spent (== maxAttempts). */
  readonly attempts: number;
  /** The lint errors on the final failed attempt (the reason). */
  readonly lastViolations: readonly string[];
  /** Human-readable honest failure message. */
  readonly message: string;
}

/**
 * LLM error / dormant: the bot port failed or is not configured. Honest — no draft.
 */
export interface ProcessGenLlmError {
  readonly status: "llm_error";
  /** "dormant" when the LLM is not configured; "error" otherwise. */
  readonly cause: "dormant" | "error";
  readonly message: string;
}

export type ProcessGenOutcome =
  | ProcessGenDraftReady
  | ProcessGenNeedsGrounding
  | ProcessGenExhausted
  | ProcessGenLlmError;

// ---------------------------------------------------------------------------
// BPMN extraction — pull the XML the bot emitted out of its chat reply.
// ---------------------------------------------------------------------------

/**
 * Extract a BPMN XML document from a bot chat reply. The bot may wrap it in a
 * ```xml fenced block``` or return it bare. We take the first <...definitions> …
 * </definitions> span (case-insensitive on the local name), falling back to any
 * fenced code block. Returns null when no XML is present (the bot replied with prose).
 */
export function extractBpmnXml(text: string): string | null {
  if (!text) return null;

  // 1. A <definitions> … </definitions> document (the canonical BPMN root).
  const defRe = /<([A-Za-z0-9]+:)?definitions\b[\s\S]*?<\/(?:[A-Za-z0-9]+:)?definitions\s*>/i;
  const defMatch = defRe.exec(text);
  if (defMatch) return defMatch[0].trim();

  // 2. A fenced ```xml ... ``` (or ```bpmn ... ```) block — take its body.
  const fenceRe = /```(?:xml|bpmn)?\s*([\s\S]*?)```/i;
  const fenceMatch = fenceRe.exec(text);
  if (fenceMatch && fenceMatch[1].trim().startsWith("<")) {
    return fenceMatch[1].trim();
  }

  return null;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/**
 * Build the chat request for one generation attempt.
 * The first attempt sends the description; repair attempts append the prior draft
 * + the lint feedback so the bot can fix it.
 */
function buildGenRequest(
  systemPrompt: string,
  history: ChatMessage[],
): ChatLlmRequest {
  return { system: systemPrompt, messages: history };
}

/**
 * Run the free-topology process generation loop.
 *
 * Algorithm (spec §3.4):
 *   for attempt in 1..maxAttempts:
 *     draft = bot.chat(history)
 *     if no XML in draft → treat as a generation miss → feedback "emit BPMN"
 *     v = validateGeneratedProcess(draft, grounding)
 *     if v.ok → DRAFT_READY (persist as draft; human reviews in modeler)
 *     if v.groundingGaps → NEEDS_GROUNDING (cascade/ask; stop the lint loop)
 *     else (lint errors) → append feedback to history → retry
 *   exhausted → EXHAUSTED (honest; no broken process emitted)
 *
 * The grounding gap short-circuits the lint loop: a missing field/role is not a
 * "fix the XML" error — it needs a cascade-create or a human answer, which is the
 * caller's job (relate_application primitive / clarification). We surface the gap and
 * the last draft so a follow-up turn can patch it once the field/role exists.
 */
export async function runProcessGenLoop(
  req: ProcessGenRequest,
): Promise<ProcessGenOutcome> {
  const maxAttempts = req.maxAttempts ?? MAX_GEN_ATTEMPTS;
  const history: ChatMessage[] = [
    {
      role: "user",
      content:
        `Опиши процесс как BPMN 2.0 свободной топологии (один <definitions> с одним ` +
        `<process>). Требование пользователя:\n${req.description}\n\n` +
        `Верни ТОЛЬКО валидный BPMN XML. Условия шлюзов используй в виде \${поле} с ` +
        `реальными ключами полей; роли назначай дорожками (lane) с понятными именами.`,
    },
  ];

  let lastValidation: GenValidationResult | null = null;
  let lastDraftXml: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let replyText: string;
    try {
      const result = await req.llm.chat(buildGenRequest(req.systemPrompt, history));
      replyText = result.text;
    } catch (err) {
      if (err instanceof LlmDormantError) {
        return {
          status: "llm_error",
          cause: "dormant",
          message:
            "LLM-порт не настроен (dormant) — генерация процесса недоступна. " +
            "Подключите модель в настройках агента.",
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: "llm_error",
        cause: "error",
        message: `Ошибка LLM-порта при генерации процесса: ${msg}.`,
      };
    }

    const xml = extractBpmnXml(replyText);

    if (!xml) {
      // The bot replied with prose, no BPMN. Treat as a generation miss and re-prompt
      // (still counts toward the attempt cap so a chatty bot cannot loop forever).
      history.push({ role: "assistant", content: replyText || "[нет ответа]" });
      history.push({
        role: "user",
        content:
          "В ответе не найден BPMN XML. Верни ТОЛЬКО документ <definitions>…</definitions> " +
          "без пояснительного текста.",
      });
      lastValidation = {
        ok: false,
        lintViolations: [
          {
            type: "malformed_xml",
            elementId: "",
            elementKind: "process",
            message: "no BPMN <definitions> document found in the reply",
          },
        ],
        groundingGaps: [],
      };
      continue;
    }

    lastDraftXml = xml;
    const validation = validateGeneratedProcess(xml, req.grounding);
    lastValidation = validation;

    // SUCCESS — grounded and lint-clean.
    if (validation.ok) {
      return {
        status: "draft_ready",
        bpmnXml: xml,
        processKey: req.processKey,
        processName: req.processName,
        attempts: attempt,
        summary:
          `Процесс «${req.processName}» собран и прошёл проверку с ${attempt}-й попытки. ` +
          `Черновик готов к ревью в Модельере (промоут — за человеком).`,
      };
    }

    // GROUNDING GAP — short-circuit the lint loop. Missing field/role → cascade/ask.
    // We surface this even if there are also lint errors, because the bot cannot fix a
    // condition that references a field that simply does not exist yet — that needs a
    // cascade-create (relate_application) or a human answer, not a re-prompt.
    if (validation.groundingGaps.length > 0) {
      return {
        status: "needs_grounding",
        gaps: validation.groundingGaps,
        message: formatGroundingFeedback(validation.groundingGaps),
        lastDraftXml: xml,
      };
    }

    // LINT ERRORS — feed back the error text and retry (unless this was the last try).
    if (attempt < maxAttempts) {
      const feedback = formatLintFeedback(validation.lintViolations);
      history.push({ role: "assistant", content: xml });
      history.push({ role: "user", content: feedback });
    }
  }

  // EXHAUSTED — honest failure. NO broken process is emitted.
  const lastViolations =
    lastValidation && !lastValidation.ok
      ? lastValidation.lintViolations.map((v) => v.message)
      : [];
  return {
    status: "exhausted",
    attempts: maxAttempts,
    lastViolations,
    message:
      `Не удалось собрать корректный процесс за ${maxAttempts} попыток. ` +
      `Последние ошибки:\n${lastViolations.map((m, i) => `${i + 1}. ${m}`).join("\n")}\n` +
      `Черновик НЕ создан (чтобы не выпустить сломанный процесс). ` +
      `Уточните требования и попробуйте снова.`,
  };
}
