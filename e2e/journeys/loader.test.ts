/**
 * e2e/journeys/loader.test.ts — T-0257 unit tests for the journey loader/dispatcher.
 *
 * These cover the PURE authoring contract WITHOUT a browser or a live stack (the
 * runner itself needs Playwright + the deployed product, exercised by the
 * acceptance gate). They prove: (1) {{slot}} interpolation threads captured ids and
 * fails honestly on an un-captured slot; (2) per-action validation accepts a
 * well-formed step and rejects a malformed one with a precise message; (3) the
 * whole-journey validator + file discovery work; (4) the migrated ТЭЛ journey is a
 * valid journey (so the data-driven runner will accept it).
 *
 * Run under vitest (default `npm test`). NOT a Playwright *.e2e.ts spec.
 */
import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  interpolate,
  interpolateRecord,
  validateStep,
  validateJourney,
  discoverJourneyFiles,
  VALID_ACTIONS,
} from "./loader.js";
import type { Journey, Step } from "./types.js";
import { journey as telJourney } from "./tel-linear.journey.js";
import { journey as uxG1Journey } from "./ux-g1-contrast.ux.journey.js";
import { journey as uxG3Journey } from "./ux-g3-dead-buttons.ux.journey.js";
import { journey as uxG4Journey } from "./ux-g4-empty-loading-error.ux.journey.js";
import { journey as uxCreationLight } from "./ux-creation-path-light.ux.journey.js";
import { journey as uxViewRegistryPanel } from "./ux-view-registry-panel.ux.journey.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("interpolate", () => {
  it("substitutes a captured slot", () => {
    expect(interpolate("/api/inbox/{{taskId}}/claim", { taskId: "t-42" })).toBe(
      "/api/inbox/t-42/claim",
    );
  });

  it("substitutes inside a CSS selector", () => {
    expect(interpolate('tr:has(:text("{{instanceId}}"))', { instanceId: "inst-9" })).toBe(
      'tr:has(:text("inst-9"))',
    );
  });

  it("handles whitespace inside the braces", () => {
    expect(interpolate("{{ id }}", { id: "x" })).toBe("x");
  });

  it("passes literal text through unchanged", () => {
    expect(interpolate("/processes", {})).toBe("/processes");
  });

  it("throws (fail-honest) on an un-captured slot", () => {
    expect(() => interpolate("{{instanceId}}", {})).toThrow(/not captured/);
  });

  it("substitutes multiple slots in one string", () => {
    expect(interpolate("{{a}}-{{b}}", { a: "1", b: "2" })).toBe("1-2");
  });
});

describe("interpolateRecord", () => {
  it("interpolates string values, leaves non-strings intact", () => {
    const out = interpolateRecord({ h: "{{taskId}}", n: 5 }, { taskId: "t-1" });
    expect(out).toEqual({ h: "t-1", n: 5 });
  });
});

describe("VALID_ACTIONS", () => {
  it("is the closed dispatch set", () => {
    expect(VALID_ACTIONS).toEqual([
      "login",
      "goto",
      "click",
      "fill",
      "expectVisible",
      "expectText",
      "expectCount",
      "pollApi",
      "apiCheck",
      "toggleTheme",   // T-0314: UX honest-gate — theme switch
      "checkContrast", // T-0314: UX honest-gate — axe-core WCAG AA/AAA
    ]);
  });
});

describe("validateStep — accepts well-formed steps", () => {
  const ok: Step[] = [
    { name: "login", action: "login", userId: "e-orlov" },
    { name: "goto", action: "goto", path: "/processes" },
    { name: "click", action: "click", target: { role: { role: "button", name: "Go" } } },
    {
      name: "click+await",
      action: "click",
      target: { css: "button" },
      awaitResponse: { urlIncludes: "/api/x", expectStatus: 201, captureJson: { id: "id" } },
    },
    { name: "fill", action: "fill", target: { css: "input" }, value: "hi" },
    { name: "vis", action: "expectVisible", target: { css: ".x" } },
    { name: "txt", action: "expectText", target: { css: ".x" }, text: "ok" },
    { name: "cnt", action: "expectCount", target: { css: ".x" }, count: 0 },
    {
      name: "poll",
      action: "pollApi",
      url: "/api/inbox",
      pickExpr: "data.items[0]?.id ?? null",
      captureAs: "taskId",
    },
    { name: "api", action: "apiCheck", url: "/api/x", expectStatus: 403 },
    { name: "api-not", action: "apiCheck", url: "/api/x", expectStatusNot: 200 },
    { name: "api-oneof", action: "apiCheck", url: "/api/x", expectStatusOneOf: [403, 404] },
    // T-0314 — new UX honest-gate actions
    { name: "toggle-light", action: "toggleTheme", theme: "light" },
    { name: "toggle-dark", action: "toggleTheme", theme: "dark" },
    { name: "contrast-default", action: "checkContrast" },
    { name: "contrast-scope", action: "checkContrast", scope: '[role="dialog"]', wcagLevel: "AAA" },
  ];
  ok.forEach((s, i) => {
    it(`accepts: ${s.name}`, () => {
      expect(() => validateStep(s, i)).not.toThrow();
    });
  });
});

describe("validateStep — rejects malformed steps with a precise message", () => {
  const bad: Array<{ step: Step; rx: RegExp }> = [
    { step: { name: "", action: "goto", path: "/x" }, rx: /missing name/ },
    {
      step: { name: "x", action: "bogus" as Step["action"], path: "/x" },
      rx: /unknown action "bogus"/,
    },
    { step: { name: "x", action: "login" }, rx: /login needs userId/ },
    { step: { name: "x", action: "goto" }, rx: /goto needs path/ },
    { step: { name: "x", action: "click" }, rx: /click needs target/ },
    { step: { name: "x", action: "fill", target: { css: "i" } }, rx: /fill needs value/ },
    { step: { name: "x", action: "expectText", target: { css: ".x" } }, rx: /expectText needs text/ },
    {
      step: { name: "x", action: "expectCount", target: { css: ".x" } },
      rx: /expectCount needs count/,
    },
    { step: { name: "x", action: "pollApi", url: "/x" }, rx: /pollApi needs pickExpr/ },
    { step: { name: "x", action: "apiCheck", url: "/x" }, rx: /apiCheck needs at least one/ },
    // a target with BOTH role and css set is ambiguous → reject
    {
      step: { name: "x", action: "click", target: { role: { role: "button" }, css: "b" } },
      rx: /exactly one of/,
    },
    // T-0314 — toggleTheme rejects missing / invalid theme value
    { step: { name: "x", action: "toggleTheme" }, rx: /toggleTheme needs theme/ },
    { step: { name: "x", action: "toggleTheme", theme: "purple" as "light" }, rx: /toggleTheme needs theme/ },
  ];
  bad.forEach(({ step, rx }, i) => {
    it(`rejects: ${step.action} (${rx.source})`, () => {
      expect(() => validateStep(step, i)).toThrow(rx);
    });
  });
});

describe("validateJourney", () => {
  const base: Journey = {
    id: "demo",
    title: "Demo",
    version: 1,
    steps: [{ name: "go", action: "goto", path: "/" }],
  };

  it("accepts a well-formed journey", () => {
    expect(() => validateJourney(base)).not.toThrow();
  });

  it("rejects a non-kebab id", () => {
    expect(() => validateJourney({ ...base, id: "Demo_X" })).toThrow(/kebab-case/);
  });

  it("rejects version < 1", () => {
    expect(() => validateJourney({ ...base, version: 0 })).toThrow(/version must be/);
  });

  it("rejects an empty steps list", () => {
    expect(() => validateJourney({ ...base, steps: [] })).toThrow(/at least one step/);
  });

  it("surfaces a bad inner step", () => {
    expect(() =>
      validateJourney({ ...base, steps: [{ name: "x", action: "login" }] }),
    ).toThrow(/login needs userId/);
  });
});

describe("discoverJourneyFiles", () => {
  it("finds the migrated tel-linear journey file (sorted)", () => {
    const files = discoverJourneyFiles(HERE);
    expect(files.some((f) => f.endsWith("tel-linear.journey.ts"))).toBe(true);
    // deterministic order
    expect(files).toEqual([...files].sort());
  });

  it("returns absolute paths in the given dir", () => {
    const files = discoverJourneyFiles(HERE);
    for (const f of files) expect(f.startsWith(join(HERE, ""))).toBe(true);
  });
});

describe("T-0314 UX honest-gate journeys", () => {
  const uxJourneys = [
    { name: "ux-g1-contrast", j: uxG1Journey },
    { name: "ux-g3-dead-buttons", j: uxG3Journey },
    { name: "ux-g4-empty-loading-error", j: uxG4Journey },
    { name: "ux-creation-path-light", j: uxCreationLight },
    { name: "ux-view-registry-panel", j: uxViewRegistryPanel },
  ];

  uxJourneys.forEach(({ name, j }) => {
    it(`${name} is a valid journey (runner will accept it)`, () => {
      expect(() => validateJourney(j)).not.toThrow();
    });

    it(`${name} has non-trivial step list`, () => {
      expect(j.steps.length).toBeGreaterThan(2);
    });
  });

  it("ux-g1-contrast uses toggleTheme and checkContrast actions", () => {
    const actions = uxG1Journey.steps.map((s) => s.action);
    expect(actions).toContain("toggleTheme");
    expect(actions).toContain("checkContrast");
  });

  it("ux-g1-contrast toggles both light and dark", () => {
    const themes = uxG1Journey.steps
      .filter((s) => s.action === "toggleTheme")
      .map((s) => s.theme);
    expect(themes).toContain("light");
    expect(themes).toContain("dark");
  });

  it("ux-g1-contrast uses wcagLevel AA", () => {
    const contrastSteps = uxG1Journey.steps.filter((s) => s.action === "checkContrast");
    expect(contrastSteps.length).toBeGreaterThan(0);
    contrastSteps.forEach((s) => {
      expect(s.wcagLevel === "AA" || s.wcagLevel === undefined).toBe(true);
    });
  });

  it("ux-g3-dead-buttons targets the inbox path", () => {
    expect(uxG3Journey.steps.some((s) => s.path === "/inbox")).toBe(true);
  });

  it("ux-g4-empty-loading-error creates an app and checks empty state", () => {
    expect(uxG4Journey.steps.some((s) => s.awaitResponse?.urlIncludes === "/api/applications")).toBe(true);
    expect(uxG4Journey.steps.some((s) => s.path?.includes("does-not-exist"))).toBe(true);
  });

  it("ux-creation-path-light uses checkContrast on dialog scope", () => {
    const scopedContrast = uxCreationLight.steps.find(
      (s) => s.action === "checkContrast" && s.scope === '[role="dialog"]',
    );
    expect(scopedContrast).toBeDefined();
  });
});

describe("migrated ТЭЛ journey", () => {
  it("is a valid journey (the runner will accept it)", () => {
    expect(() => validateJourney(telJourney)).not.toThrow();
  });

  it("has the expected identity + a non-trivial step list", () => {
    expect(telJourney.id).toBe("tel-linear");
    expect(telJourney.version).toBeGreaterThanOrEqual(1);
    expect(telJourney.steps.length).toBeGreaterThan(10);
  });

  it("captures instanceId on the start click and threads it forward", () => {
    const startStep = telJourney.steps.find(
      (s) => s.awaitResponse?.urlIncludes === "/api/processes/start",
    );
    expect(startStep?.awaitResponse?.captureJson).toEqual({ instanceId: "instanceId" });
    // a later step references {{instanceId}}
    expect(
      telJourney.steps.some((s) => s.target?.css?.includes("{{instanceId}}")),
    ).toBe(true);
  });

  it("captures taskId via pollApi and uses it in the claim url", () => {
    const poll = telJourney.steps.find((s) => s.action === "pollApi");
    expect(poll?.captureAs).toBe("taskId");
    expect(
      telJourney.steps.some((s) => s.awaitResponse?.urlIncludes.includes("{{taskId}}")),
    ).toBe(true);
  });
});
