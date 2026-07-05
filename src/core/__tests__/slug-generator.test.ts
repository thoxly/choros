/**
 * src/core/__tests__/slug-generator.test.ts — T-0650
 *
 * Unit tests for the canonical slug generator (transliteration, grammar
 * compliance, collision-suffix resolution). Anti-case: fixtures are generic
 * synthetic names ("Тестовое приложение", "Отдел продаж"), never the founder's
 * concrete business case.
 */

import { describe, expect, it } from "vitest";
import {
  SLUG_GENERATOR_RE,
  generateSlugFromName,
  generateUniqueSlug,
  transliterate,
} from "../slug-generator.js";

describe("SLUG_GENERATOR_RE", () => {
  it("matches the documented canonical grammar", () => {
    expect(SLUG_GENERATOR_RE.source).toBe("^[a-z0-9][a-z0-9-]{0,63}$");
  });

  it("accepts lowercase alphanumeric + dash, rejects uppercase/space/leading-dash", () => {
    expect(SLUG_GENERATOR_RE.test("sales-eu")).toBe(true);
    expect(SLUG_GENERATOR_RE.test("a")).toBe(true);
    expect(SLUG_GENERATOR_RE.test("Sales")).toBe(false);
    expect(SLUG_GENERATOR_RE.test("-lead")).toBe(false);
    expect(SLUG_GENERATOR_RE.test("with space")).toBe(false);
    expect(SLUG_GENERATOR_RE.test("")).toBe(false);
  });
});

describe("transliterate", () => {
  it("maps Cyrillic letters to latin equivalents", () => {
    expect(transliterate("тест")).toBe("test");
    expect(transliterate("щ")).toBe("sch");
    expect(transliterate("ъ")).toBe("");
    expect(transliterate("ь")).toBe("");
  });

  it("leaves latin/digit input untouched", () => {
    expect(transliterate("abc123")).toBe("abc123");
  });
});

describe("generateSlugFromName", () => {
  it("transliterates a Cyrillic name into a compliant slug", () => {
    expect(generateSlugFromName("Тестовое приложение")).toBe("testovoe-prilozhenie");
  });

  it("transliterates a multi-word Cyrillic name with punctuation", () => {
    expect(generateSlugFromName("Отдел продаж (ЕС)")).toBe("otdel-prodazh-es");
  });

  it("handles a latin name (dash-cases it, lowercase)", () => {
    expect(generateSlugFromName("Sales Team")).toBe("sales-team");
  });

  it("collapses repeated separators and strips leading/trailing dashes", () => {
    expect(generateSlugFromName("  --Test  Name--  ")).toBe("test-name");
  });

  it("falls back to a generic 'item' for empty/whitespace-only input", () => {
    expect(generateSlugFromName("")).toBe("item");
    expect(generateSlugFromName("   ")).toBe("item");
  });

  it("falls back to a generic 'item' when the name is only symbols", () => {
    expect(generateSlugFromName("!!!###")).toBe("item");
  });

  it("truncates to at most 60 characters", () => {
    const long = "A".repeat(100);
    expect(generateSlugFromName(long).length).toBeLessThanOrEqual(60);
  });

  it("every generated slug satisfies SLUG_GENERATOR_RE", () => {
    const names = ["Тестовое приложение", "Sales Team", "", "!!!", "A".repeat(200), "Отдел №1"];
    for (const n of names) {
      expect(SLUG_GENERATOR_RE.test(generateSlugFromName(n))).toBe(true);
    }
  });
});

describe("generateUniqueSlug", () => {
  it("returns the base slug when no collision", async () => {
    const key = await generateUniqueSlug("Тестовое приложение", async () => false);
    expect(key).toBe("testovoe-prilozhenie");
  });

  it("appends -2 on first collision (anti-case: synthetic name, not founder's case)", async () => {
    let calls = 0;
    const key = await generateUniqueSlug("Отдел продаж", async () => {
      calls++;
      return calls === 1; // base taken, -2 free
    });
    expect(key).toBe("otdel-prodazh-2");
  });

  it("appends -3 when base and -2 are both taken", async () => {
    let calls = 0;
    const key = await generateUniqueSlug("Отдел продаж", async () => {
      calls++;
      return calls <= 2;
    });
    expect(key).toBe("otdel-prodazh-3");
  });

  it("falls back to a uuid-derived suffix once numbered attempts are exhausted", async () => {
    let calls = 0;
    const key = await generateUniqueSlug("Отдел продаж", async () => {
      calls++;
      return calls <= 10; // base + base-2..base-10 all taken (10 calls)
    });
    expect(key).toMatch(/^otdel-prodazh-[0-9a-f]{8}$/);
    expect(key).not.toBe("otdel-prodazh");
  });

  it("respects a custom maxNumberedAttempts", async () => {
    let calls = 0;
    const key = await generateUniqueSlug(
      "Отдел продаж",
      async () => {
        calls++;
        return true; // always taken
      },
      { maxNumberedAttempts: 1 },
    );
    // base (1 call) + base-2 (1 call) = 2 calls before uuid fallback
    expect(calls).toBe(2);
    expect(key).toMatch(/^otdel-prodazh-[0-9a-f]{8}$/);
  });
});
