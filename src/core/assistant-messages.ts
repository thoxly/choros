/**
 * src/core/assistant-messages.ts — T-0573 (ADR-T0573 §2.2 B3): user-facing
 * text for the assistant's honest "LLM unavailable" answer.
 *
 * Used for BOTH unavailability paths (dormant — no config at all; adapter —
 * config exists but the call failed), so the user sees ONE consistent,
 * human-readable message regardless of which path fired (per admin branch).
 *
 * T-0595 (UX_REVIEW T-0573 F-1/F-2): the SINGLE constant is split into TWO —
 * an admin variant and a non-admin variant — because `/llm-connections` lives
 * in the admin nav-zone (nav-config.js:162, capability sentinel
 * `mgmt_object:*`). A builder-non-admin who saw the bare path in F-1 could
 * neither click it (no deep-link) nor reach it via their own nav (admin zone
 * hidden from them) — a dead door. `respondLlmUnavailable`
 * (src/http/assistant.ts:1160) resolves the caller's admin status via the
 * EXISTING `loadAdminContext` resolver (src/db/org.ts) and picks the text:
 *
 *   ADMIN     — the caller CAN act. F-2: the bare "(/llm-connections)" is
 *               removed from the prose — a clickable deep-link button now
 *               carries "where"/"how" (error.deepLinks in the envelope,
 *               ADR-T0595 §1.2). The page is still named so a human reads a
 *               sentence, not a path. UX_REVIEW T-0595 F-1: the page is named
 *               by its FACTUAL nav/h1 title «LLM-соединения»
 *               (nav-config.js:162, screen-llm-connections.jsx h1), not a
 *               paraphrase.
 *   NON_ADMIN — the caller CANNOT act (no admin capability). No path, no
 *               button — honestly directs them to ask their tenant admin.
 *               UX_REVIEW T-0595 F-4: the tail says what happens NEXT («когда
 *               ключ подключат, ассистент начнёт отвечать») instead of a
 *               «затем повторите» instruction the caller cannot themselves
 *               satisfy.
 *
 * F6/AC-6/AC-7 (T-0573) requirements STILL apply to BOTH constants:
 *   (a) states plainly that a working LLM key must be connected/checked;
 *   (b) contains NO dev-jargon (no `LLM_NOT_CONFIGURED`, `OpenAILlmPort`,
 *       `endpoint`, `secretHandle`, `stack`, raw exception text).
 * The ADMIN constant no longer needs to literally contain "/llm-connections"
 * (F-2) — that requirement is now satisfied structurally, by the deep-link
 * descriptor in the envelope, not by a substring in the prose.
 */

export const ASSISTANT_LLM_UNAVAILABLE_MESSAGE_ADMIN =
  "Ассистент пока не может ответить — не подключён рабочий LLM-ключ. " +
  "Подключите или проверьте ключ на странице «LLM-соединения», затем повторите.";

export const ASSISTANT_LLM_UNAVAILABLE_MESSAGE_NON_ADMIN =
  "Ассистент пока не может ответить — не подключён рабочий LLM-ключ. " +
  "Обратитесь к администратору вашей организации, чтобы подключить ключ — " +
  "когда ключ подключат, ассистент начнёт отвечать.";
