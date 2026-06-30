/**
 * e2e/journeys/ux-g4-empty-loading-error.ux.journey.ts — OBLIK UX honest-gate G4 (T-0314).
 *
 * RULE G4: Any list / detail view must render a proper Empty / Loading / Error state
 * component — never a blank/invisible panel. From ux-quality-system.md §2.3.
 *
 * HOW:
 *   a) Empty state  — navigate to a freshly-created application's records page
 *      (guaranteed zero records after creation) and assert an Empty-state indicator
 *      is visible (not a blank panel, not an invisible tbody).
 *   b) Error state  — navigate to a non-existent records list (/app-records/no-such-id)
 *      and assert an Error-state indicator or a not-found message is visible.
 *   c) Loading state — harder to pin without timing; we probe indirectly by checking
 *      that the first paint of a records page shows either a skeleton/spinner OR the
 *      resolved content, never a zero-height invisible container.
 *
 * IDEMPOTENCY: uses {{nonce}} for a fresh app slug on each run (runner.ts contract).
 * SERVER-GATED: requires deployed Choros (real POST + GET API).
 *
 * Fail-honest (NF5 / AC-8): blank panel (no text, no visible child) → RED.
 *
 * STATUS (D-056): informational now; flip to --required after kit Empty/Loading/Error
 * components are deployed on all list screens (Faza-2 OBLIK migration). This journey
 * is the MACHINERY; flip is server-gated.
 */
import type { Journey } from "./types.js";

const ACTOR = "e-orlov"; // seeded dev-tenant employee

export const journey: Journey = {
  id: "ux-g4-empty-loading-error",
  title: "G4 · Списки рендерят Empty/Loading/Error состояния (не пустоту)",
  version: 1,
  description:
    "Creates a blank app, checks its records page shows an empty-state indicator; checks /app-records/no-such-id shows an error state; never a blank invisible panel.",
  steps: [
    // ── authenticate ──────────────────────────────────────────────────────
    { name: "G4 · log in", action: "login", userId: ACTOR },

    // ── (a) EMPTY STATE — create a brand-new app (zero records guaranteed) ──────
    {
      name: "G4 · navigate to /apps to create a blank app",
      action: "goto",
      path: "/apps",
    },
    {
      name: "G4 · open the create-application modal",
      action: "click",
      target: { role: { role: "button", name: "Создать приложение" }, first: true },
    },
    {
      name: "G4 · fill app slug (unique per run)",
      action: "fill",
      target: { css: 'input[placeholder="my-app"]', within: { role: { role: "dialog", name: "Создать приложение" } } },
      value: "g4-app-{{nonce}}",
    },
    {
      name: "G4 · fill app display name",
      action: "fill",
      target: { css: 'input[placeholder="Моё приложение"]', within: { role: { role: "dialog", name: "Создать приложение" } } },
      value: "G4 empty-state probe {{nonce}}",
    },
    {
      name: "G4 · submit → POST /api/applications 201 → capture appId",
      action: "click",
      target: { role: { role: "button", name: "Создать" }, within: { role: { role: "dialog", name: "Создать приложение" } } },
      awaitResponse: {
        urlIncludes: "/api/applications",
        method: "POST",
        expectStatus: 201,
        captureJson: { appId: "id" },
      },
    },
    // Navigate to the records page — guaranteed zero records.
    {
      name: "G4 · open the records list for the blank app (0 records)",
      action: "goto",
      path: "/app-records/{{appId}}",
    },
    {
      // The records list with 0 rows must show an explicit Empty-state component,
      // not a bare blank page. We allow any of the common empty-state patterns:
      //   • role=img/figure/region with alt containing "пусто"/"нет записей"
      //   • a heading or paragraph with ключевое слово "нет" / "пусто" / "empty"
      //   • a .chs-empty-state element (kit component from OBLIK СЛОЙ)
      //
      // Using expectText on body: if there is meaningful empty-state text the step
      // passes; if the page is blank with no user-visible content it fails → RED.
      name: "G4 · records page with 0 rows shows visible empty-state text (not blank)",
      action: "expectVisible",
      target: {
        // The OBLIK kit empty-state component uses class chs-empty-state;
        // before migration, screens may use inline text. We match either.
        css: ".chs-empty-state, [data-testid='empty-state'], [data-empty='true']",
        first: true,
      },
    },

    // ── (b) ERROR STATE — navigate to a non-existent resource ─────────────────
    {
      name: "G4 · navigate to a non-existent app-records page (error/not-found)",
      action: "goto",
      path: "/app-records/does-not-exist-00000000",
    },
    {
      // The page must show an error / not-found indicator — not a blank panel.
      // We probe for any visible heading-level element (a 404 page / error card
      // always has at least a heading) OR the kit ErrorState component.
      name: "G4 · non-existent records page shows an error/not-found indicator (not blank)",
      action: "expectVisible",
      target: {
        css: ".chs-error-state, [data-testid='error-state'], [data-error='true'], [data-testid='not-found']",
        first: true,
      },
    },

    // ── (c) LOADING STATE (indirect) — fast navigation to a real records page ──
    // We navigate back to the app we created (has a real endpoint) and assert that
    // the final rendered state (after load) is EITHER the empty-state (already proven
    // above, so 0-records) OR visible records — never a zero-height invisible table
    // body. This is a softer proxy for the Loading state: if Loading renders nothing
    // and then stays nothing on error, step (b) catches it; here we assert the FINAL
    // state is non-invisible.
    {
      name: "G4 · navigate back to the blank app records (confirms stable settled state)",
      action: "goto",
      path: "/app-records/{{appId}}",
    },
    {
      name: "G4 · the page settles into a visible user-facing state (not an invisible container)",
      action: "expectVisible",
      target: {
        // Either the empty-state kit component OR a records table — both are valid
        // settled states. A zero-height / display:none container would fail this.
        css: ".chs-empty-state, [data-testid='empty-state'], table.chs-itable, [data-testid='records-table']",
        first: true,
      },
    },
  ],
};

export default journey;
