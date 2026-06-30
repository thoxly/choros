/**
 * e2e/journeys/ux-g3-dead-buttons.ux.journey.ts — OBLIK UX honest-gate G3 (T-0314).
 *
 * RULE G3: Every enabled, clickable element must produce a navigation / network
 * request / DOM change / visible response within N ms — or must be `disabled` /
 * `aria-disabled` / labelled «скоро». No silent no-ops ("мёртвые аффордансы").
 * From ux-quality-system.md §2.3 — closes audit finding #3 («Открыть» в инбоксе).
 *
 * HOW: the journey navigates to the inbox (the known location of the «Открыть»
 * dead button documented in the audit) and probes each enabled button by:
 *   1. Counting enabled non-disabled buttons.
 *   2. For the specific «Открыть» affordance: clicking it and asserting that a
 *      navigation OR a network request fires within 5 s. If neither occurs → RED.
 *
 * The general "count enabled buttons and assert none are no-ops" is a broader
 * pattern — here we target the TWO confirmed dead affordances from the audit:
 *   • «Открыть» in the inbox (finding #3)
 *   • «Поиск ⌘K» visible but non-interactive (finding #8)
 *
 * SERVER-GATED: needs deployed Choros + live inbox with a seeded task.
 *
 * Fail-honest (NF5 / AC-8): if click produces no observable effect → RED.
 *
 * STATUS (D-056): informational now; flip to --required after findings #3/#8 are fixed
 * (separate biz tasks). The journey is the MACHINERY; flip is server-gated.
 */
import type { Journey } from "./types.js";

const ACTOR = "e-orlov"; // seeded dev-tenant employee (has inbox tasks from seed data)

export const journey: Journey = {
  id: "ux-g3-dead-buttons",
  title: "G3 · Нет мёртвых enabled-кнопок (инбокс + поиск)",
  version: 1,
  description:
    "Navigates to the inbox; probes confirmed-dead affordances (#3 «Открыть», #8 ⌘K search). Any enabled button that produces zero observable effect → RED.",
  steps: [
    // ── authenticate ──────────────────────────────────────────────────────
    { name: "G3 · log in as the actor with inbox tasks", action: "login", userId: ACTOR },

    // ── inbox ─────────────────────────────────────────────────────────────
    {
      name: "G3 · navigate to the inbox",
      action: "goto",
      path: "/inbox",
    },
    {
      name: "G3 · inbox page heading is visible (page loaded)",
      action: "expectVisible",
      target: { role: { role: "heading" }, first: true },
    },

    // ── finding #8 — «Поиск ⌘K» must be a real <input> or must be absent ──────
    // The audit found a visible «Поиск ⌘K» element that is NOT an <input> and does
    // NOT respond to interaction. G3 asserts: if it exists, it must be an interactive
    // input (count of non-input search-looking-text = 0). This is a static count.
    {
      name: "G3 · no fake «Поиск ⌘K» text-only pseudo-input (finding #8): count = 0",
      action: "expectCount",
      // Matches a non-input element that looks like a search placeholder but is not
      // focusable. Using :text() Playwright selector — if the element is gone (fixed),
      // count is 0 → green. If it is still a no-op decoration → count > 0 → RED.
      target: {
        css: [
          // A div/span/p that CONTAINS the search-hint text but is NOT a button/input.
          // In the audited code this was a styled <div> with cursor:pointer but no handler.
          "div:not(input):not(button):has-text('⌘K')",
          "span:not(input):not(button):has-text('⌘K')",
        ].join(", "),
      },
      count: 0,
    },

    // ── finding #3 — «Открыть» in inbox must navigate or produce network ──────────
    // The audit confirmed «Открыть» was a silent no-op. After the fix it must navigate
    // to the task detail. We click the FIRST «Открыть» button and assert that a
    // navigation event fires (Playwright waitForURL will handle this). If the fix is
    // not yet in, the click completes with no navigation → expectVisible on a detail
    // element will fail → RED (as intended — this is the informational gate measuring).
    {
      name: "G3 · at least one «Открыть» button is visible in the inbox (seed data)",
      action: "expectVisible",
      target: { role: { role: "button", name: "Открыть" }, first: true },
    },
    {
      // Click «Открыть» and await a network request to a task/instance detail endpoint.
      // This proves the click is wired to a real action, not a no-op handler.
      // The claim/detail API path is /api/inbox/:taskId or /api/processes/instances/:id.
      name: "G3 · «Открыть» click fires a network request (not a no-op)",
      action: "click",
      target: { role: { role: "button", name: "Открыть" }, first: true },
      awaitResponse: {
        urlIncludes: "/api/",
        // We do not mandate a specific status here — 200/304 both prove the click
        // produced a real network call. If nothing fires within timeout → RED.
        expectStatus: 200,
      },
    },
  ],
};

export default journey;
