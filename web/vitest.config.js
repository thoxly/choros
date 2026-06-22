/**
 * web/vitest.config.js  (T-0408 · D7-FU)
 *
 * Vitest configuration for the web (SPA) test tier.
 *
 * All web test files import pure .js modules (no JSX at the test-module boundary;
 * .jsx screen files are intentionally excluded so logic lives in testable .js
 * siblings). Node 22 provides URL, URLSearchParams, crypto.subtle natively, and
 * several tests stub out browser globals (localStorage, fetch) manually — so the
 * default "node" environment is the right choice: fast, no jsdom overhead, honest.
 *
 * vitest itself lives in the ROOT node_modules (root package.json devDependency).
 * The web/node_modules symlink points at choros/web/node_modules which does NOT
 * contain vitest. Running `npx vitest` from the web directory works because npm
 * resolves the binary from the root checkout's node_modules/.bin (via the symlink
 * chain). The config therefore imports from "vitest/config" — vitest resolves it
 * from the root node_modules at runtime.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Root for discovery: all *.test.js files anywhere under web/src/.
    // Exclude nothing extra — there are no db, worktree, or CI-check files here.
    include: ['src/**/*.test.js', 'src/**/*.test.jsx'],
    // node environment: tests stub browser globals themselves (see auth-headers.test.js).
    environment: 'node',
    // No globalSetup (no DB isolation needed for pure-logic web tests).
  },
});
