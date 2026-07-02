/**
 * src/core/assistant-messages.ts — T-0573 (ADR-T0573 §2.2 B3): user-facing
 * text for the assistant's honest "LLM unavailable" answer.
 *
 * Used for BOTH unavailability paths (dormant — no config at all; adapter —
 * config exists but the call failed), so the user sees ONE consistent,
 * human-readable message regardless of which path fired.
 *
 * F6/AC-6/AC-7 requirements on this text:
 *   (a) states plainly that a working LLM key must be connected/checked;
 *   (b) contains the `/llm-connections` path (where to act);
 *   (c) contains NO dev-jargon (no `LLM_NOT_CONFIGURED`, `OpenAILlmPort`,
 *       `endpoint`, `secretHandle`, `stack`, raw exception text).
 */

export const ASSISTANT_LLM_UNAVAILABLE_MESSAGE =
  "Ассистент пока не может ответить — не подключён рабочий LLM-ключ. " +
  "Подключите или проверьте ключ на странице «Подключения LLM» (/llm-connections), затем повторите.";
