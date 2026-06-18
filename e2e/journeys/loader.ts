/**
 * e2e/journeys/loader.ts — T-0257.
 *
 * PURE (no Playwright, no browser, no I/O beyond fs.readdir) journey loading +
 * validation + the {{slot}} interpolation engine. Split out from runner.ts so the
 * authoring contract — "is this journey file well-formed?" and "does interpolation
 * thread captured ids correctly?" — is unit-testable under vitest WITHOUT a browser
 * or a live stack (the runner itself needs Playwright + the deployed product).
 *
 * Zero product deps: node:fs / node:path + the journey types only.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Journey, Step, StepAction, Locator } from "./types.js";

/** The closed set of valid actions — the runner's dispatch keys. */
export const VALID_ACTIONS: readonly StepAction[] = [
  "login",
  "goto",
  "click",
  "fill",
  "expectVisible",
  "expectText",
  "expectCount",
  "pollApi",
  "apiCheck",
];

/** A captured-value bag threaded through a journey run. */
export type Bag = Readonly<Record<string, string>>;

/**
 * Interpolate {{slot}} references in a string from the bag. A reference to an
 * un-captured slot throws (fail-honest: a journey must not silently run with an
 * empty id where a real one was expected). Literal text passes through unchanged.
 */
export function interpolate(template: string, bag: Bag): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, key: string) => {
    if (!(key in bag)) {
      throw new Error(
        `journey interpolation: slot {{${key}}} is not captured (have: ${Object.keys(bag).join(", ") || "none"})`,
      );
    }
    return bag[key]!;
  });
}

/** Deep-interpolate a record's string values (used for headers / body). */
export function interpolateRecord(
  rec: Readonly<Record<string, unknown>>,
  bag: Bag,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    out[k] = typeof v === "string" ? interpolate(v, bag) : v;
  }
  return out;
}

/** Throw with a journey-scoped message if `cond` is false. */
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** Validate a Locator shape (exactly one primary locator field set). */
function validateLocator(loc: Locator, where: string): void {
  const primaries = [loc.role, loc.css].filter((x) => x !== undefined);
  assert(
    primaries.length === 1,
    `${where}: a target must set exactly one of { role, css } (got ${primaries.length})`,
  );
  if (loc.has) validateLocator(loc.has, `${where}.has`);
  if (loc.within) validateLocator(loc.within, `${where}.within`);
}

/**
 * Validate ONE step against its action's required fields. Throws on the first
 * violation with a precise, journey-author-facing message (the authoring contract).
 */
export function validateStep(step: Step, idx: number): void {
  const where = `step[${idx}] "${step.name ?? "(unnamed)"}"`;
  assert(typeof step.name === "string" && step.name.length > 0, `${where}: missing name`);
  assert(
    VALID_ACTIONS.includes(step.action),
    `${where}: unknown action "${step.action}" (valid: ${VALID_ACTIONS.join(", ")})`,
  );

  switch (step.action) {
    case "login":
      assert(typeof step.userId === "string" && step.userId.length > 0, `${where}: login needs userId`);
      break;
    case "goto":
      assert(typeof step.path === "string" && step.path.length > 0, `${where}: goto needs path`);
      break;
    case "click":
      assert(step.target !== undefined, `${where}: click needs target`);
      validateLocator(step.target, where);
      if (step.awaitResponse) {
        assert(
          typeof step.awaitResponse.urlIncludes === "string",
          `${where}: awaitResponse needs urlIncludes`,
        );
      }
      break;
    case "fill":
      assert(step.target !== undefined, `${where}: fill needs target`);
      validateLocator(step.target, where);
      assert(typeof step.value === "string", `${where}: fill needs value`);
      break;
    case "expectVisible":
      assert(step.target !== undefined, `${where}: expectVisible needs target`);
      validateLocator(step.target, where);
      break;
    case "expectText":
      assert(step.target !== undefined, `${where}: expectText needs target`);
      validateLocator(step.target, where);
      assert(typeof step.text === "string" && step.text.length > 0, `${where}: expectText needs text`);
      break;
    case "expectCount":
      assert(step.target !== undefined, `${where}: expectCount needs target`);
      validateLocator(step.target, where);
      assert(typeof step.count === "number" && step.count >= 0, `${where}: expectCount needs count >= 0`);
      break;
    case "pollApi":
      assert(typeof step.url === "string" && step.url.length > 0, `${where}: pollApi needs url`);
      assert(typeof step.pickExpr === "string" && step.pickExpr.length > 0, `${where}: pollApi needs pickExpr`);
      assert(typeof step.captureAs === "string" && step.captureAs.length > 0, `${where}: pollApi needs captureAs`);
      break;
    case "apiCheck": {
      assert(typeof step.url === "string" && step.url.length > 0, `${where}: apiCheck needs url`);
      const asserts = [step.expectStatus, step.expectStatusOneOf, step.expectStatusNot].filter(
        (x) => x !== undefined,
      );
      assert(
        asserts.length >= 1,
        `${where}: apiCheck needs at least one of { expectStatus, expectStatusOneOf, expectStatusNot }`,
      );
      break;
    }
  }
}

/** Validate a whole Journey object's shape. Throws on the first violation. */
export function validateJourney(j: Journey): void {
  assert(typeof j.id === "string" && /^[a-z0-9-]+$/.test(j.id), `journey: id must be kebab-case (got "${j.id}")`);
  assert(typeof j.title === "string" && j.title.length > 0, `journey "${j.id}": missing title`);
  assert(typeof j.version === "number" && j.version >= 1, `journey "${j.id}": version must be >= 1`);
  assert(Array.isArray(j.steps) && j.steps.length > 0, `journey "${j.id}": must have at least one step`);
  j.steps.forEach((s, i) => validateStep(s, i));
}

/** A loaded journey paired with its source file for reporting. */
export interface LoadedJourney {
  readonly file: string;
  readonly journey: Journey;
}

/**
 * Discover *.journey.ts files in a directory (sorted, deterministic). Returns
 * absolute file paths. Used by the spec to import + run every journey — adding a
 * journey is dropping a file here, zero runner-code change.
 */
export function discoverJourneyFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".journey.ts") || f.endsWith(".journey.js"))
    .sort()
    .map((f) => join(dir, f));
}
