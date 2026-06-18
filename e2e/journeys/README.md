# Deploy-acceptance journeys (T-0257)

A **journey** is a versioned user-journey expressed as **data**: an ordered list of
steps a real user performs against the **deployed** Choros (the built `web/dist`
served by the real HTTP server, against live Postgres + Flowable — **no mocks**).

The keystone of the factory's definition-of-"done": "done" means a journey runs
green against the deployed product, not that a unit test passes on a branch.

## How to add a new journey (zero runner-code change)

1. Drop a file `e2e/journeys/<your-id>.journey.ts` that exports a `Journey`:

   ```ts
   import type { Journey } from "./types.js";

   export const journey: Journey = {
     id: "customer-onboarding",          // kebab-case, stable
     title: "Customer onboarding — happy path",
     version: 1,                          // bump when you change the steps
     description: "Vendor onboards a customer and issues a key.",
     steps: [
       { name: "log in as vendor admin", action: "login", userId: "v-admin" },
       { name: "open customers", action: "goto", path: "/customers" },
       {
         name: "click «New customer»",
         action: "click",
         target: { role: { role: "button", name: "New customer" } },
       },
       // …
     ],
   };
   export default journey;
   ```

2. That's it. `e2e/journeys.e2e.ts` **discovers** every `*.journey.ts` file and runs
   it through the generic runner (`e2e/journeys/runner.ts`). You do **not** touch any
   harness/runner code.

3. Run it: `npm run acceptance` (rebuilds `web/dist`, launches the server against the
   live stack, bootstraps, then runs every journey + the fail-honest negative spec).

## The step vocabulary (closed set)

Each step has a `name` (the human-readable acceptance line) and an `action`. Strings
(selectors, urls, values) support `{{slot}}` interpolation from captured values.

| action          | required fields                                  | what it does |
|-----------------|--------------------------------------------------|--------------|
| `login`         | `userId`                                         | writes the SPA dev-user session (localStorage), fetching the real record from `/api/users` |
| `goto`          | `path`                                           | navigates to a path (relative to `baseURL`) |
| `click`         | `target` (+ optional `awaitResponse`)            | clicks an element; optionally awaits a write response, asserts its status, and **captures** body fields |
| `fill`          | `target`, `value`                                | types a value into an input |
| `expectVisible` | `target`                                         | asserts an element is visible |
| `expectText`    | `target`, `text`                                 | asserts the element contains text (or a `/regex/i` literal) |
| `expectCount`   | `target`, `count`                                | asserts a locator resolves to exactly N matches (e.g. `0`) |
| `pollApi`       | `url`, `pickExpr`, `captureAs`                   | polls a read API until `pickExpr(data)` returns a value; captures it (for async projections) |
| `apiCheck`      | `url` + one of `expectStatus`/`expectStatusOneOf`/`expectStatusNot` | API-only fail-honest invariant (e.g. cross-tenant start must be 403) |

### Targeting an element (`Locator`)

Set **exactly one** primary locator:

- `role: { role: "button", name: "Запустить процесс" }` — ARIA role + accessible name
  (`name` may be a `/regex/` string, e.g. `"/Из пула/"`).
- `css: 'tr:has(:text("{{instanceId}}"))'` — raw CSS / Playwright selector.

Optional modifiers: `first: true` (take the first match), `has: { … }` (narrow to
rows that contain a child locator), `scope: { frame: "iframe.chs-form-viewer" }`
(descend into a sandbox iframe — used for the form submit).

### Capturing + threading ids

A `click` with `awaitResponse.captureJson: { instanceId: "instanceId" }` captures the
created id; later steps reference it as `{{instanceId}}`. A `pollApi` with
`captureAs: "taskId"` captures an async-projected id. Referencing an un-captured slot
**throws** (fail-honest — no silent run with an empty id).

### `{{nonce}}` — a per-run unique token (built-in)

The bag is pre-seeded with **`{{nonce}}`** before the first step: a unique
lowercase base36 token (valid as a slug fragment). Use it for re-run-safe unique
identifiers in a create-journey — e.g. `value: "acc-{{nonce}}"` for an application
slug — so a `UNIQUE (tenant_id, slug)` row never `409`s on a repeat run. This keeps
journeys idempotent **without** a destructive bootstrap (the acceptance bootstrap is
read-only by construction — `ci/checks/acceptance/seed-idempotent.sh` forbids
`TRUNCATE`/`DELETE` there).

## Running

- `npm run acceptance` — declarative journeys (every `*.journey.ts`) + the
  fail-honest negative spec, against the deployed product.
- `npm run acceptance:tel` — back-compat: the original imperative ТЭЛ U1→U5 spec +
  the negative spec (`ACCEPTANCE_JOURNEYS=skip`).

Both go through the same gate (`ops/acceptance-tel.mjs`): force-rebuild `web/dist` +
`tsc`, launch the server on `ACCEPTANCE_PORT` (default 3100) against Postgres:55432 +
Flowable:8082, idempotent bootstrap, run Playwright (headless, `retries: 0`),
teardown. Env knobs: `ACCEPTANCE_PORT`, `DATABASE_URL`, `FLOWABLE_REST_BASE_URL`,
`ACCEPTANCE_NO_BUILD=1` (reuse artifacts).

## Why two files for ТЭЛ?

`e2e/tel-linear.e2e.ts` (imperative) is kept as the load-bearing fail-honest
reference the acceptance fitness checks grep; `e2e/journeys/tel-linear.journey.ts` is
the **migrated** declarative version — the proof the generic runner reproduces the
exact U1→U5 click-through. `acceptance:tel` runs the former, `acceptance` the latter
(each skips the other to avoid double-running the same flow).

## Unit tests

The pure loader/dispatcher (interpolation, per-action validation, discovery) is
unit-tested in `e2e/journeys/loader.test.ts` under `npm test` — no browser or live
stack needed. The runner itself is exercised live by the acceptance gate.
