#!/usr/bin/env node
/**
 * ops/acceptance-tel.mjs — T-0283 (ADR T-0278 §E / §2.4).
 *
 * `npm run acceptance:tel` — the deploy-acceptance gate runner. Drives the U1→U5
 * ТЭЛ click-through against the REAL stack (NO mocks, FF-3 / NF1 / D-056):
 *
 *   1. Build web/dist (vite build) if absent — the gate must drive the SAME built
 *      artifact a user sees (NF1), not the vite dev server.
 *   2. Compile the TS server (tsc) if dist/ is absent.
 *   3. Launch the choros server from THIS checkout on ACCEPTANCE_PORT (default 3100),
 *      pointed at the live Postgres + Flowable, with DEMO_TENANT_SLUG=dev so the
 *      login picker + resolveActorTenant resolve to the `dev` tenant whose id
 *      matches the UI LaunchModal's hardcoded x-tenant-id.
 *   4. Run the idempotent bootstrap (deploy tel-linear BPMN + verify seeded actors).
 *   5. `playwright test` (happy + negative).
 *   6. Tear the server down.
 *
 * Exit code is the playwright exit code (fail-honest: any non-clickable step ⇒ ≠0).
 * Env knobs (all default to the live dev stack):
 *   ACCEPTANCE_PORT, DATABASE_URL, FLOWABLE_REST_BASE_URL, FLOWABLE_PORT,
 *   FLOWABLE_REST_APP_ADMIN_PASSWORD, ACCEPTANCE_NO_BUILD (skip web/tsc build).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.ACCEPTANCE_PORT ?? "3100";
const BASE_URL = `http://localhost:${PORT}`;

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://choros_migrator:choros_dev_pw@localhost:55432/choros";
const FLOWABLE_PORT = process.env.FLOWABLE_PORT ?? "8082";
const FLOWABLE_REST_BASE_URL =
  process.env.FLOWABLE_REST_BASE_URL ??
  `http://localhost:${FLOWABLE_PORT}/flowable-rest/service`;
const FLOWABLE_PASS =
  process.env.FLOWABLE_REST_APP_ADMIN_PASSWORD ?? "choros_flowable_dev_pw";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
  }
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server at ${url} did not become ready in ${timeoutMs}ms`);
}

async function main() {
  // 1+2. Build artifacts (skippable when already built).
  if (!process.env.ACCEPTANCE_NO_BUILD) {
    if (!existsSync(resolve(ROOT, "web/dist/index.html"))) {
      console.log("[acceptance:tel] building web/dist (vite build)…");
      run("npm", ["--prefix", "web", "run", "build"]);
    }
    if (!existsSync(resolve(ROOT, "dist/index.js"))) {
      console.log("[acceptance:tel] compiling server (tsc)…");
      run("npx", ["tsc"]);
    }
  }

  // 3. Launch the worktree server pointed at the live stack.
  console.log(`[acceptance:tel] launching choros server on ${BASE_URL}…`);
  const serverEnv = {
    ...process.env,
    PORT,
    DATABASE_URL,
    FLOWABLE_REST_BASE_URL,
    FLOWABLE_PORT,
    FLOWABLE_REST_APP_ADMIN_PASSWORD: FLOWABLE_PASS,
    FLOWABLE_REST_APP_ADMIN_USER_ID:
      process.env.FLOWABLE_REST_APP_ADMIN_USER_ID ?? "admin",
    DEMO_TENANT_SLUG: process.env.DEMO_TENANT_SLUG ?? "dev",
    CHOROS_WEB_DIST: resolve(ROOT, "web/dist"),
  };
  const server = spawn("node", ["dist/index.js"], {
    cwd: ROOT,
    env: serverEnv,
    stdio: "inherit",
  });

  let playwrightStatus = 1;
  try {
    await waitForServer(BASE_URL);

    // 4. Idempotent bootstrap (deploy BPMN + verify seeded actors).
    console.log("[acceptance:tel] running bootstrap (deploy + verify)…");
    run("npx", ["tsx", "e2e/bootstrap-tel.ts"], {
      env: { ...process.env, ACCEPTANCE_BASE_URL: BASE_URL },
    });

    // 5. Playwright (skip the in-config bootstrap re-run — already done in step 4).
    console.log("[acceptance:tel] running playwright click-through…");
    const pw = spawnSync("npx", ["playwright", "test"], {
      cwd: ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        ACCEPTANCE_BASE_URL: BASE_URL,
        ACCEPTANCE_SKIP_BOOTSTRAP: "1",
      },
    });
    playwrightStatus = pw.status ?? 1;
  } finally {
    // 6. Tear the server down.
    server.kill("SIGTERM");
  }

  process.exit(playwrightStatus);
}

main().catch((err) => {
  console.error(`[acceptance:tel] FAIL: ${err.message}`);
  process.exit(1);
});
