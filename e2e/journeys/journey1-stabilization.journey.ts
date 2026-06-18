/**
 * e2e/journeys/journey1-stabilization.journey.ts — T-0261.
 *
 * Stage-1 STABILIZATION deploy-acceptance journey: the proof that the product
 * opens, authenticates, and renders an honest start screen with NO 500s.
 *
 * This is the first gate of the reality-gap fix (E13 Stage 1): it does NOT assert
 * full create-flows (those are Journey #2 constructor-vertical, Journey #3 ТЭЛ) — it
 * asserts that the product is navigable and honest on the running stack:
 *
 *   S1 — real dev-auth login writes a session; the app shell renders (nav visible,
 *        no crash/error screen).
 *   S2 — honest nav (T-0260) is present: at least one «демо» badge and at least one
 *        «скоро» badge are visible in the sidebar. These are REAL DOM elements —
 *        a missing badge means the nav-config or shell no longer renders honest status.
 *   S3 — the previously-broken endpoints are graceful: GET /api/processes → 200
 *        and GET /api/rights → 200. A 500 on either turns the journey RED (T-0259
 *        anti-regression).
 *   S4 — navigating to Инбокс (/inbox) and Процессы (/processes) renders live screens
 *        without error states (the screen heading is visible).
 *
 * FAIL-HONEST (NF5 / AC-8): every assertion is a hard assertion. A 500, a missing
 * badge, or a broken screen turns this run RED — weakening any assertion to force
 * green defeats the whole point of the gate. Adding another journey = drop a sibling
 * *.journey.ts file; zero runner/harness change needed (T-0257 contract).
 */
import type { Journey } from "./types.js";

// The actor for the Stage-1 stabilization check. Any seeded dev-tenant user works;
// Орлов is the canonical actor used across the acceptance suite (migration 013).
const ACTOR = "e-orlov";

export const journey: Journey = {
  id: "journey1-stabilization",
  title: "Stage 1 stabilization — login, honest nav, no 500s, live screens",
  version: 1,
  description:
    "Open the product, really log in, assert the honest nav badges exist, " +
    "assert /api/processes and /api/rights return 200 (not 500), " +
    "and navigate to Инбокс + Процессы without error states.",
  steps: [
    // ───────────────────────────────────── S1 · Login + app shell (T-0258)
    {
      name: "S1 · log in as the canonical actor (real dev-auth)",
      action: "login",
      userId: ACTOR,
    },
    {
      // After login the runner navigates to "/" in doLogin; we now navigate to
      // /inbox so the shell fully renders with the authenticated session.
      name: "S1 · open the inbox (post-login landing)",
      action: "goto",
      path: "/inbox",
    },
    {
      // The aside.chs-nav is the sidebar rendered by AppShell once the user is
      // logged in. If auth failed or the shell crashed, this will not be visible.
      name: "S1 · app shell sidebar is visible (auth succeeded, no crash)",
      action: "expectVisible",
      target: { css: "aside.chs-nav" },
    },
    {
      // The brand logo block renders inside the authenticated shell.
      name: "S1 · «Choros» brand name is visible in the nav",
      action: "expectVisible",
      target: { css: ".chs-nav__name" },
    },

    // ───────────────────────────────────── S2 · Honest nav (T-0260)
    // T-0260 wired nav-config.js status fields into NavItem in shell.jsx:
    //   status === "demo" → <span class="chs-navitem__demo">демо</span>
    //   status === "soon" → <span class="chs-navitem__soon">скоро</span>
    // The nav-config has: forms=demo, budgets=soon (org flipped to live in T-0269).
    // A missing badge means the honest-nav feature is broken.
    {
      name: "S2 · at least one «демо» badge is visible in the sidebar nav (honest-nav live)",
      action: "expectVisible",
      target: { css: ".chs-navitem__demo", first: true },
    },
    {
      name: "S2 · at least one «скоро» badge is visible in the sidebar nav (honest-nav live)",
      action: "expectVisible",
      target: { css: ".chs-navitem__soon", first: true },
    },
    {
      // Specifically assert the «Формы задач» nav item carries its demo badge
      // (nav-config.js: { id: "forms", status: "demo" }). This is a developer-sandbox
      // screen and is stable as demo — it is not on the path to flipping live soon.
      // «Оргструктура» was here before but correctly flipped to live in T-0269.
      name: "S2 · «Формы задач» nav item has the «демо» badge (nav-config status=demo)",
      action: "expectVisible",
      target: {
        css: ".chs-navitem__demo",
        within: { css: 'button.chs-navitem[title="Формы задач (демо)"]' },
      },
    },
    {
      // Specifically assert the «Бюджеты» nav item carries its «скоро» badge
      // (nav-config.js: { id: "budgets", status: "soon" }).
      name: "S2 · «Бюджеты» nav item has the «скоро» badge (nav-config status=soon)",
      action: "expectVisible",
      target: {
        css: ".chs-navitem__soon",
        within: { css: 'button.chs-navitem[title="Скоро"]' },
      },
    },

    // ───────────────────────────────────── S3 · No 500s on critical endpoints (T-0259)
    // GET /api/processes must return 200. T-0259 made it degrade to graceful-200
    // ({ instances: [], demo: true }) when pack is absent — a 500 here is a regression.
    {
      name: "S3 · GET /api/processes → 200 (no 500, T-0259 anti-regression)",
      action: "apiCheck",
      url: "/api/processes",
      headers: { "x-dev-user": ACTOR },
      expectStatus: 200,
    },
    // GET /api/rights must return 200. Same graceful-degrade (T-0259): returns
    // { roles: [], demo: true } on pack-miss, never 500.
    {
      name: "S3 · GET /api/rights → 200 (no 500, T-0259 anti-regression)",
      action: "apiCheck",
      url: "/api/rights",
      headers: { "x-dev-user": ACTOR },
      expectStatus: 200,
    },
    // GET /api/inbox → 200 (this is live, used by the ТЭЛ journey; confirms
    // the inbox API is up for this user on this stack).
    {
      name: "S3 · GET /api/inbox → 200 (live inbox endpoint is up)",
      action: "apiCheck",
      url: "/api/inbox",
      headers: { "x-dev-user": ACTOR },
      expectStatus: 200,
    },

    // ───────────────────────────────────── S4 · Live screens render without error (T-0259/T-0260)
    // Navigate to Инбокс and assert the screen renders (a heading or known element).
    // If the screen shows an error panel instead of the live data, this step will fail.
    {
      name: "S4 · navigate to /inbox",
      action: "goto",
      path: "/inbox",
    },
    {
      // The inbox screen renders tab buttons (Мне / Из пула) — a meaningful
      // live-screen indicator (not just the nav). If the screen crashed/500s,
      // these will not be visible.
      name: "S4 · inbox tab buttons visible (screen rendered without error)",
      action: "expectVisible",
      target: { role: { role: "button", name: "/^Мне/" }, first: true },
    },
    // Navigate to Процессы and assert the «Запустить процесс» button is present.
    // This button was confirmed live by the ТЭЛ journey (T-0257 tel-linear).
    {
      name: "S4 · navigate to /processes",
      action: "goto",
      path: "/processes",
    },
    {
      name: "S4 · «Запустить процесс» button visible on the processes screen (screen live)",
      action: "expectVisible",
      target: { role: { role: "button", name: "Запустить процесс" }, first: true },
    },
  ],
};

export default journey;
