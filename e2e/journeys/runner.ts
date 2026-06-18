/**
 * e2e/journeys/runner.ts — T-0257 (declarative deploy-acceptance journey-runner).
 *
 * The GENERIC runner: given a `Journey` (DATA) + a Playwright `Page`, it executes
 * each step against the DEPLOYED product (real built web/dist + live HTTP + Postgres
 * + Flowable — NO mocks, FF-3 / NF1 / D-056). The dispatch table is CLOSED (one case
 * per StepAction); a journey author never edits this file — they drop a journey file
 * (./loader.discoverJourneyFiles) and the same runner drives it.
 *
 * Fail-honest (NF5 / AC-8): every assertion is a hard `expect`; an unreachable
 * affordance, a non-2xx write, or a missing async projection turns the run RED. No
 * retries, no flaky-masking (playwright.config.ts retries:0).
 *
 * Separation of concerns (T-0257 AC): this file is the journey-RUNNER. The
 * acceptance-GATE wiring (force-rebuild web/dist + tsc, launch the server, bootstrap,
 * teardown) stays in ops/acceptance-tel.mjs. The runner assumes the server is up and
 * the bootstrap has run.
 */
import { expect, type Page, type Locator as PwLocator, type FrameLocator } from "@playwright/test";
import { interpolate, interpolateRecord, type Bag } from "./loader.js";
import type { Journey, Step, Locator, RoleName } from "./types.js";

/** A Playwright locator scope: the page, a frame, or another locator (for `within`). */
type LocatorRoot = Page | FrameLocator | PwLocator;

/**
 * Turn a journey text value into a string or a RegExp. A value wrapped in /…/ (e.g.
 * "/Из пула/" or "/done|Готово/i") becomes a RegExp — the SAME convention used for
 * `expectText` — so a journey author writes regex matchers as plain serializable
 * strings. Plain text is interpolated and returned literally.
 */
function toMatcher(value: string, bag: Bag): string | RegExp {
  const interpolated = interpolate(value, bag);
  const m = interpolated.match(/^\/(.*)\/([a-z]*)$/);
  return m ? new RegExp(m[1]!, m[2]) : interpolated;
}

/** Resolve an accessible-name matcher for getByRole (string | regex | undefined). */
function resolveName(
  name: string | RegExp | undefined,
  bag: Bag,
): string | RegExp | undefined {
  if (name === undefined) return undefined;
  if (name instanceof RegExp) return name;
  return toMatcher(name, bag);
}

/** Resolve a journey Locator (+ {{slot}} interpolation) to a Playwright locator. */
function resolveLocator(page: Page, loc: Locator, bag: Bag): PwLocator {
  // Choose the root the locator resolves under, in priority order:
  //   1. `within` — a descendant of another (resolved) container locator.
  //   2. `scope: { frame }` — inside a sandbox iframe.
  //   3. the top page (default).
  let root: LocatorRoot = page;
  if (loc.within) {
    root = resolveLocator(page, loc.within, bag);
  } else if (loc.scope && typeof loc.scope === "object" && "frame" in loc.scope) {
    root = page.frameLocator(interpolate(loc.scope.frame, bag));
  }

  let pw: PwLocator;
  if (loc.role) {
    pw = root.getByRole(loc.role.role as RoleName, {
      name: resolveName(loc.role.name, bag),
    });
  } else if (loc.css) {
    pw = root.locator(interpolate(loc.css, bag));
  } else {
    throw new Error("resolveLocator: target has neither role nor css");
  }

  if (loc.has) {
    // `has` narrows to elements containing the child locator (resolved on the page,
    // per Playwright's filter contract).
    pw = pw.filter({ has: resolveLocator(page, loc.has, bag) });
  }
  if (loc.first) pw = pw.first();
  return pw;
}

/**
 * Log in as a dev user by writing the localStorage session the SPA reads — fetching
 * the real user record from the live /api/users picker (so name/position are real).
 * This is the SAME mechanism the original tel-linear.e2e.ts loginAs used, lifted
 * into the runner so a journey expresses login as a single declarative step.
 */
async function doLogin(page: Page, userId: string): Promise<void> {
  await page.goto("/");
  const record = await page.evaluate(async (id: string) => {
    const res = await fetch("/api/users");
    const data = (await res.json()) as { users?: Array<{ id: string }> };
    return (data.users ?? []).find((u) => u.id === id) ?? null;
  }, userId);
  expect(record, `login: picker must list user "${userId}"`).not.toBeNull();
  await page.evaluate((rec) => {
    localStorage.setItem("chs-dev-user", JSON.stringify(rec));
  }, record);
}

/** Poll a read API (through the SPA origin) until pickExpr yields a value. */
async function doPollApi(page: Page, step: Step, bag: Bag): Promise<string> {
  const url = interpolate(step.url!, bag);
  const headers = step.headers ? (interpolateRecord(step.headers, bag) as Record<string, string>) : {};
  const pickExpr = interpolate(step.pickExpr!, bag);
  const method = step.httpMethod ?? "GET";
  const timeoutMs = step.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const picked = await page.evaluate(
      async (args: { url: string; headers: Record<string, string>; method: string; pickExpr: string }) => {
        const res = await fetch(args.url, { method: args.method, headers: args.headers });
        if (!res.ok) return null;
        const data = await res.json();
        // The journey author supplies a pure pick expression over `data`. Evaluated
        // in the browser (Function ctor) so the journey stays serializable DATA.
        // eslint-disable-next-line no-new-func
        const pick = new Function("data", `return (${args.pickExpr});`) as (d: unknown) => unknown;
        const v = pick(data);
        return v == null ? null : String(v);
      },
      { url, headers, method, pickExpr },
    );
    if (picked) return picked;
    await page.waitForTimeout(500);
  }
  return "";
}

/** Run an API-only fail-honest invariant (status assertion). */
async function doApiCheck(page: Page, step: Step, bag: Bag): Promise<void> {
  const url = interpolate(step.url!, bag);
  const method = step.httpMethod ?? "GET";
  const headers = step.headers ? (interpolateRecord(step.headers, bag) as Record<string, string>) : {};
  const body = step.body ? JSON.stringify(interpolateRecord(step.body, bag)) : undefined;

  const status = await page.evaluate(
    async (args: { url: string; method: string; headers: Record<string, string>; body?: string }) => {
      const res = await fetch(args.url, {
        method: args.method,
        headers: args.headers,
        body: args.body,
      });
      return res.status;
    },
    { url, method, headers, body },
  );

  if (step.expectStatus !== undefined) {
    expect(status, `${step.name}: status must be ${step.expectStatus}`).toBe(step.expectStatus);
  }
  if (step.expectStatusOneOf !== undefined) {
    expect(step.expectStatusOneOf, `${step.name}: status must be one of ${step.expectStatusOneOf.join("/")}`).toContain(
      status,
    );
  }
  if (step.expectStatusNot !== undefined) {
    expect(status, `${step.name}: status must NOT be ${step.expectStatusNot}`).not.toBe(step.expectStatusNot);
  }
}

/** Click a target, optionally awaiting a write response (with status + capture). */
async function doClick(page: Page, step: Step, bag: Bag): Promise<Bag> {
  const target = resolveLocator(page, step.target!, bag);
  if (!step.awaitResponse) {
    await target.click();
    return bag;
  }
  const ar = step.awaitResponse;
  const urlIncludes = interpolate(ar.urlIncludes, bag);
  const [resp] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes(urlIncludes) && (ar.method === undefined || r.request().method() === ar.method),
    ),
    target.click(),
  ]);
  if (ar.expectStatus !== undefined) {
    expect(resp.status(), `${step.name}: response ${urlIncludes} must be ${ar.expectStatus}`).toBe(ar.expectStatus);
  }
  let next = bag;
  if (ar.captureJson) {
    const json = (await resp.json()) as Record<string, unknown>;
    const captured: Record<string, string> = { ...bag };
    for (const [slot, field] of Object.entries(ar.captureJson)) {
      const v = json[field];
      expect(v, `${step.name}: response body must contain "${field}" to capture {{${slot}}}`).toBeTruthy();
      captured[slot] = String(v);
    }
    next = captured;
  }
  return next;
}

/** Execute one step; returns the (possibly extended) capture bag. */
async function runStep(page: Page, step: Step, bag: Bag): Promise<Bag> {
  switch (step.action) {
    case "login":
      await doLogin(page, step.userId!);
      return bag;
    case "goto":
      await page.goto(interpolate(step.path!, bag));
      return bag;
    case "click":
      return doClick(page, step, bag);
    case "fill":
      await resolveLocator(page, step.target!, bag).fill(interpolate(step.value!, bag));
      return bag;
    case "expectVisible":
      await expect(resolveLocator(page, step.target!, bag), step.name).toBeVisible();
      return bag;
    case "expectText": {
      // /regex/ literal support (toMatcher): a value wrapped in /…/ becomes a RegExp.
      const matcher = toMatcher(step.text!, bag);
      await expect(resolveLocator(page, step.target!, bag), step.name).toContainText(matcher);
      return bag;
    }
    case "expectCount":
      await expect(resolveLocator(page, step.target!, bag), step.name).toHaveCount(step.count!);
      return bag;
    case "pollApi": {
      const v = await doPollApi(page, step, bag);
      expect(v, `${step.name}: pollApi yielded no value within timeout`).toBeTruthy();
      return { ...bag, [step.captureAs!]: v };
    }
    case "apiCheck":
      await doApiCheck(page, step, bag);
      return bag;
    default: {
      // Exhaustiveness guard — a new action without a case is a compile error.
      const _never: never = step.action;
      throw new Error(`runStep: unhandled action ${String(_never)}`);
    }
  }
}

/**
 * Run a whole journey against the deployed product. Each step is a hard assertion;
 * a captured value (e.g. instanceId) threads forward via {{slot}} interpolation.
 */
export async function runJourney(page: Page, journey: Journey): Promise<void> {
  let bag: Bag = {};
  for (const step of journey.steps) {
    bag = await runStep(page, step, bag);
  }
}
