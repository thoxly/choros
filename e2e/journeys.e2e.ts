/**
 * e2e/journeys.e2e.ts — T-0257 (declarative deploy-acceptance journey-runner).
 *
 * The GENERIC acceptance spec: it DISCOVERS every e2e/journeys/*.journey.ts file and
 * runs each through the same data-driven runner (e2e/journeys/runner.ts) against the
 * DEPLOYED product (built web/dist + live HTTP + Postgres + Flowable — NO mocks,
 * FF-3 / NF1 / D-056). Adding a new acceptance journey is dropping a file in
 * e2e/journeys/ — this spec picks it up with ZERO code change here (AC: a new journey
 * is added by dropping a file).
 *
 * Discovery is synchronous (fs) so Playwright registers one `test()` per journey at
 * collection time; the journey module is imported lazily inside the test body, then
 * validated (loader.validateJourney — the authoring contract) and run.
 *
 * This spec COEXISTS with the original tel-linear.e2e.ts / tel-linear-negative.e2e.ts
 * (kept as the load-bearing fail-honest specs the acceptance fitness checks grep).
 * To avoid double-running the migrated ТЭЛ flow, set ACCEPTANCE_LEGACY_TEL=skip when
 * driving the declarative path, or ACCEPTANCE_JOURNEYS=skip for the legacy-only path.
 */
import { test } from "@playwright/test";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverJourneyFiles, validateJourney } from "./journeys/loader.js";
import { runJourney } from "./journeys/runner.js";
import type { Journey } from "./journeys/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const JOURNEY_DIR = join(HERE, "journeys");

const files = discoverJourneyFiles(JOURNEY_DIR);

test.describe("declarative deploy-acceptance journeys", () => {
  test.skip(
    process.env["ACCEPTANCE_JOURNEYS"] === "skip",
    "journeys disabled via ACCEPTANCE_JOURNEYS=skip",
  );
  for (const file of files) {
    const label = basename(file).replace(/\.journey\.(ts|js)$/, "");
    test(`journey: ${label}`, async ({ page }) => {
      const mod = (await import(file)) as { journey?: Journey; default?: Journey };
      const journey = mod.journey ?? mod.default;
      if (!journey) {
        throw new Error(`${file}: must export a \`journey\` (named or default)`);
      }
      validateJourney(journey);
      await runJourney(page, journey);
    });
  }
});
