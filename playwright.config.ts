/**
 * playwright.config.ts — T-0283 (ADR T-0278 §E / §2.4, FF-6 / NF2 / AC-10).
 *
 * The deploy-acceptance gate is honest ONLY if it drives the SAME built artifact a
 * user sees (web/dist served by the real choros HTTP server) against the real
 * Postgres + Flowable stack — never a mock / in-memory fallback (FF-3 / NF1 / D-056).
 *
 * Test-discovery isolation (NF2 / AC-10 / FF-6 — mirrors vitest.config.js exactly):
 * the run must pick up ONLY the e2e specs of THIS checkout. Without the explicit
 * exclude, Playwright recursively discovers specs from stale git-worktrees
 * (.claude/worktrees/*, ../choros-wt/*) and runs them twice / on stale code →
 * a non-deterministic gate (FE-2026-W24-0005). `testDir: e2e/` + `testMatch` pin
 * the discovery root; `testIgnore` mirrors the vitest exclude list verbatim.
 *
 * baseURL points at the locally-launched choros server (default :3100), set by the
 * bootstrap / acceptance:tel script. trace is captured on first retry so a
 * fail-honest red (AC-8) is diagnosable.
 *
 * NOTE: this file is OUTSIDE tsconfig.json's `include` (["src"]) and eslint's
 * `files` (["src/**"]), so it does not affect the zero-runtime-dep `ci` job
 * (tsc/eslint/vitest). Playwright compiles its own TS at run time (ADR §4 cost note).
 */
import { defineConfig } from "@playwright/test";

const BASE_URL = process.env["ACCEPTANCE_BASE_URL"] ?? "http://localhost:3100";

export default defineConfig({
  testDir: "e2e",
  // Deterministic idempotent bootstrap (deploy tel-linear BPMN + verify seeded
  // actors) BEFORE any spec (FF-4 / NF3). No-op when ACCEPTANCE_SKIP_BOOTSTRAP is
  // set (the acceptance:tel script runs it as a separate step first).
  globalSetup: "./e2e/bootstrap-tel.ts",
  // Only *.e2e.ts specs of THIS checkout. bootstrap-tel.ts is a helper, not a spec.
  testMatch: ["**/*.e2e.ts"],
  // NF2 / FF-6: mirror vitest.config.js exclude verbatim so stale-worktree specs
  // are never discovered (the honesty invariant of the gate).
  testIgnore: [
    "**/.claude/**",
    "**/../choros-wt/**",
    "../choros-wt/**",
    "**/web/**",
    "**/node_modules/**",
  ],
  // The gate is a single honest linear run — no parallelism (the happy spec walks
  // ONE instance U1→U5; sharding would race the shared engine + audit projection).
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: process.env["CI"] ? "github" : "list",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
});
