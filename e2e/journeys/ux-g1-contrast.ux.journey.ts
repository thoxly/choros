/**
 * e2e/journeys/ux-g1-contrast.ux.journey.ts — OBLIK UX honest-gate G1 (T-0314).
 *
 * RULE G1: Text/background contrast ≥ WCAG AA (4.5:1 normal, 3:1 large/UI) in BOTH
 * themes (light and dark). From ux-quality-system.md §2.3 — closes audit finding #1.
 *
 * HOW: renders the constructor /apps screen (the SPA's primary construction surface)
 * in light theme and then dark theme, injecting axe-core (colour-contrast rule) each
 * time and asserting zero violations.
 *
 * SERVER-GATED: this journey runs against the DEPLOYED Choros stack (real web/dist +
 * HTTP server). Headless OK; no live-user bootstrap needed beyond a valid dev-user.
 *
 * Fail-honest (NF5 / AC-8): any axe-core colour-contrast violation → RED.
 *
 * NOTE (D-056 flip): G1 is currently `informational` (measures, does not block merge).
 * After the OBLIK overhaul completes and all screens pass, it will be flipped to
 * `--required` (server-gated follow-up, separate task). This file is the MACHINERY;
 * the flip is in `ci/checks/ux/*.sh` wiring — not in this journey.
 */
import type { Journey } from "./types.js";

const ACTOR = "e-orlov"; // seeded dev-tenant employee (migrations 013)

export const journey: Journey = {
  id: "ux-g1-contrast",
  title: "G1 · Контраст ≥ WCAG AA в обеих темах (light + dark)",
  version: 1,
  description:
    "Renders /apps in light theme then dark theme; injects axe-core colour-contrast rule; asserts zero violations in each. Closes audit finding #1.",
  steps: [
    // ── authenticate ──────────────────────────────────────────────────────
    { name: "G1 · log in as dev actor", action: "login", userId: ACTOR },

    // ── LIGHT THEME ───────────────────────────────────────────────────────
    {
      name: "G1 · navigate to /apps (constructor entry point)",
      action: "goto",
      path: "/apps",
    },
    {
      name: "G1 · switch to LIGHT theme",
      action: "toggleTheme",
      theme: "light",
    },
    {
      name: "G1 · assert zero axe colour-contrast violations in LIGHT theme (body scope)",
      action: "checkContrast",
      wcagLevel: "AA",
    },

    // ── DARK THEME ────────────────────────────────────────────────────────
    {
      name: "G1 · switch to DARK theme",
      action: "toggleTheme",
      theme: "dark",
    },
    {
      name: "G1 · assert zero axe colour-contrast violations in DARK theme (body scope)",
      action: "checkContrast",
      wcagLevel: "AA",
    },

    // ── LIGHT THEME — process-list screen (a second surface, broader coverage) ──
    {
      name: "G1 · navigate to /processes (process list, second surface)",
      action: "goto",
      path: "/processes",
    },
    {
      name: "G1 · switch back to LIGHT theme on /processes",
      action: "toggleTheme",
      theme: "light",
    },
    {
      name: "G1 · assert zero axe colour-contrast violations on /processes in LIGHT",
      action: "checkContrast",
      wcagLevel: "AA",
    },
    {
      name: "G1 · switch to DARK theme on /processes",
      action: "toggleTheme",
      theme: "dark",
    },
    {
      name: "G1 · assert zero axe colour-contrast violations on /processes in DARK",
      action: "checkContrast",
      wcagLevel: "AA",
    },
  ],
};

export default journey;
