/**
 * e2e/journeys/types.ts — T-0257 (declarative deploy-acceptance journey-runner).
 *
 * A JOURNEY is DATA: an ordered list of steps a user performs against the DEPLOYED
 * Choros (built web/dist served by the real HTTP server + live Postgres + Flowable —
 * NO mocks, FF-3 / NF1 / D-056). Journeys are VERSIONED in the repo (e2e/journeys/
 * *.journey.ts) and authored/edited as the product changes — a developer adds a new
 * acceptance scenario by DROPPING a file here, with ZERO change to the runner code.
 *
 * This generalizes the s31 ТЭЛ-specific harness (one hardcoded U1→U5 smoke) into a
 * data-driven runner: the runner (./runner.ts) loads a Journey and executes each
 * step via Playwright; the dispatch table is closed (a fixed set of `action`s) so a
 * journey author never touches imperative test code.
 *
 * Design notes:
 *   • A small, CLOSED vocabulary of actions covers the canonical acceptance shape:
 *     navigate, click, type, submit-and-await-a-write, assert a user-visible result,
 *     poll a read API for an async projection, and run an API-only invariant check.
 *     Anything outside this set is a signal the vocabulary needs a (reviewed)
 *     extension — NOT an ad-hoc imperative escape hatch in a journey file.
 *   • CAPTURE + INTERPOLATION: a step may `capture` a value from a server response
 *     (e.g. the created instanceId) into a named slot; later steps reference it with
 *     `{{instanceId}}` in selectors / urls / values. This is what lets a linear flow
 *     thread the id of the thing it just created through subsequent steps as DATA.
 *   • Zero product deps: types only — no runtime. Compiled by Playwright / by
 *     e2e/tsconfig.json; never part of the zero-dep `ci` job (include: ["src"]).
 */

/** A target inside a sandboxed iframe (e.g. the FormViewer form). */
export interface FrameTarget {
  /** CSS selector of the <iframe> element to descend into (frameLocator). */
  readonly frame: string;
}

/** Where a selector resolves: the top page (default) or inside a named iframe. */
export type Scope = "page" | FrameTarget;

/** How to locate an element. Exactly ONE locator field is set. */
export interface Locator {
  /** ARIA role + accessible name, e.g. { role: "button", name: "Запустить процесс" }. */
  readonly role?: { readonly role: RoleName; readonly name?: string | RegExp };
  /** Raw CSS / Playwright selector, e.g. 'tr:has(:text("{{instanceId}}"))'. */
  readonly css?: string;
  /** Resolve inside this iframe instead of the top page. */
  readonly scope?: Scope;
  /** Take the first match when the locator is ambiguous (default false). */
  readonly first?: boolean;
  /** Narrow to rows/elements that themselves CONTAIN this child locator. */
  readonly has?: Locator;
  /**
   * Scope this locator UNDER a container — resolve the container first, then find
   * this locator as a descendant of it (Playwright container.getByRole/.locator).
   * Use for "the «Запустить» button INSIDE the launch dialog". Distinct from `has`
   * (which filters the OUTER element to ones that contain a child, e.g. a table row).
   */
  readonly within?: Locator;
}

/** ARIA roles the journeys use (kept narrow on purpose — extend when needed). */
export type RoleName = "button" | "dialog" | "link" | "textbox" | "heading" | "checkbox";

/** WCAG conformance level for checkContrast. */
export type WcagLevel = "AA" | "AAA";

/** An HTTP write/read the step waits for, with a captured field + status assert. */
export interface AwaitResponse {
  /** Substring the response url must include, e.g. "/api/processes/start". */
  readonly urlIncludes: string;
  /** HTTP method to match (default any). */
  readonly method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** Assert the response status equals this (fail-honest: non-match ⇒ red). */
  readonly expectStatus?: number;
  /** Capture fields from the JSON body into named slots, e.g. { instanceId: "instanceId" }. */
  readonly captureJson?: Readonly<Record<string, string>>;
}

/**
 * One ordered step. `name` is the human label (the acceptance line). `action`
 * selects the dispatch. Other fields are action-specific (validated by the runner).
 * String fields (selector names, urls, values) support {{slot}} interpolation.
 */
export interface Step {
  /** Human-readable step label (e.g. "U1 · launch the canonical ТЭЛ"). */
  readonly name: string;
  readonly action: StepAction;

  // --- login -------------------------------------------------------------
  /** login: the dev-user id to authenticate as (writes the SPA localStorage session). */
  readonly userId?: string;

  // --- goto --------------------------------------------------------------
  /** goto: the path to navigate to (relative to baseURL), e.g. "/processes". */
  readonly path?: string;

  // --- click / fill / expect* (element-targeting actions) ---------------
  /** The element this step acts on / asserts. */
  readonly target?: Locator;
  /** fill: the value to type into the targeted input ({{slot}} interpolated). */
  readonly value?: string;

  // --- click + waitForResponse (a click that triggers a write) -----------
  /** When set, the step awaits this response (concurrently with the click). */
  readonly awaitResponse?: AwaitResponse;

  // --- expectVisible / expectText / expectCount --------------------------
  /** expectText: substring or /regex/ the target must contain. */
  readonly text?: string;
  /** expectCount: the exact match count the locator must resolve to (e.g. 0). */
  readonly count?: number;

  // --- pollApi (await an async read projection) --------------------------
  /** pollApi/apiCheck: the read/write endpoint path ({{slot}} interpolated). */
  readonly url?: string;
  /** pollApi/apiCheck: HTTP method (default GET). */
  readonly httpMethod?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** pollApi/apiCheck: request headers ({{slot}} interpolated on values). */
  readonly headers?: Readonly<Record<string, string>>;
  /** apiCheck: request body (JSON-stringified; {{slot}} interpolated). */
  readonly body?: Readonly<Record<string, unknown>>;
  /**
   * pollApi: a JS expression body that receives the parsed JSON `data` and must
   * return the captured value (truthy ⇒ found, stop polling) or null (keep polling).
   * Kept as a STRING so the journey stays serializable DATA, evaluated in the
   * browser via page.evaluate. e.g. "(data.items||[]).find(i=>i.inst==='{{instanceId}}')?.id ?? null".
   */
  readonly pickExpr?: string;
  /** pollApi: capture the picked value into this slot. */
  readonly captureAs?: string;
  /** pollApi: max poll time in ms (default 15000). */
  readonly timeoutMs?: number;

  // --- apiCheck (API-only fail-honest invariant) -------------------------
  /** apiCheck: the response status must equal this (e.g. 403 for the cross-tenant moat). */
  readonly expectStatus?: number;
  /** apiCheck: the response status must be one of these (e.g. [403, 404]). */
  readonly expectStatusOneOf?: readonly number[];
  /** apiCheck: the response status must NOT equal this (e.g. not 200 for the approve moat). */
  readonly expectStatusNot?: number;

  // --- toggleTheme -------------------------------------------------------
  /**
   * toggleTheme: the theme to switch TO. Sets `data-theme` on `<html>` and, when the
   * app uses a ThemeProvider, calls its toggle so the SPA is coherent. One of
   * "light" | "dark". The runner verifies `<html>` reflects the expected value.
   */
  readonly theme?: "light" | "dark";

  // --- checkContrast -----------------------------------------------------
  /**
   * checkContrast: a CSS selector scoping the subtree to audit (default "body").
   * The runner injects axe-core (colour-contrast rule) and fails if ANY violation
   * is found in the given scope in the currently-active theme.
   */
  readonly scope?: string;
  /**
   * checkContrast: WCAG conformance level — "AA" (default, 4.5:1 text / 3:1 UI)
   * or "AAA" (7:1 text). Drives the axe `runOptions` tag list.
   */
  readonly wcagLevel?: WcagLevel;
}

/** The closed set of step actions the runner dispatches. */
export type StepAction =
  | "login" // write the SPA dev-user session (localStorage)
  | "goto" // navigate to a path
  | "click" // click an element (optionally awaiting a write response)
  | "fill" // type a value into an input
  | "expectVisible" // assert an element is visible
  | "expectText" // assert an element contains text/regex
  | "expectCount" // assert a locator resolves to exactly N matches
  | "pollApi" // poll a read API until pickExpr yields a value; capture it
  | "apiCheck" // run an API-only request and assert its status (fail-honest)
  | "toggleTheme" // switch the SPA theme (light | dark) and assert <html data-theme>
  | "checkContrast"; // inject axe-core and assert colour-contrast ≥ WCAG AA/AAA

/**
 * A versioned user-journey. `version` lets a journey evolve with the product while
 * keeping the file diffable; `id` is the stable key the runner uses for reporting.
 */
export interface Journey {
  /** Stable identifier (kebab-case), e.g. "tel-linear". */
  readonly id: string;
  /** Human title shown in the test report. */
  readonly title: string;
  /** Monotonic version of THIS journey's shape (bump when steps change). */
  readonly version: number;
  /** One-line description of what the journey proves. */
  readonly description?: string;
  /** The ordered steps. */
  readonly steps: readonly Step[];
}
