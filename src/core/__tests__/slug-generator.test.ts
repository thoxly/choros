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
  GENERIC_SLUG_FALLBACK,
  SLUG_GENERATOR_RE,
  generateSlugFromName,
  generateUniqueSlug,
  insertWithUniqueSlugRetry,
  transliterate,
} from "../slug-generator.js";

// A synthetic pg 23505 unique_violation error (anti-case: no real case content).
function conflictError() {
  const e = new Error("duplicate key value violates unique constraint") as Error & { code: string };
  e.code = "23505";
  return e;
}

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

  it("falls back to the exported GENERIC_SLUG_FALLBACK for empty/whitespace-only input", () => {
    expect(GENERIC_SLUG_FALLBACK).toBe("item");
    expect(generateSlugFromName("")).toBe(GENERIC_SLUG_FALLBACK);
    expect(generateSlugFromName("   ")).toBe(GENERIC_SLUG_FALLBACK);
  });

  it("falls back to GENERIC_SLUG_FALLBACK when the name is only symbols (F1 boundary: process-key path coerces this back to 'process')", () => {
    expect(generateSlugFromName("!!!###")).toBe(GENERIC_SLUG_FALLBACK);
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

describe("insertWithUniqueSlugRetry (atomic retry-on-INSERT-conflict)", () => {
  it("returns the row from the FIRST insertFn call when the base slug is free", async () => {
    const got = await insertWithUniqueSlugRetry("Отдел продаж", async (slug) => ({ slug }));
    expect(got).toEqual({ slug: "otdel-prodazh" });
  });

  it("retries with -2 when the base INSERT throws a 23505", async () => {
    let n = 0;
    const got = await insertWithUniqueSlugRetry("Отдел продаж", async (slug) => {
      n++;
      if (n === 1) throw conflictError(); // base collides
      return { slug };
    });
    expect(got).toEqual({ slug: "otdel-prodazh-2" });
  });

  it("propagates a NON-conflict error immediately (no retry, no swallow)", async () => {
    const boom = new Error("some other db error");
    await expect(
      insertWithUniqueSlugRetry("Отдел продаж", async () => { throw boom; }),
    ).rejects.toBe(boom);
  });

  it("terminates with a bounded number of insertFn calls under always-conflict (F3 upper bound)", async () => {
    // base + base-2..base-10 (9 numbered) + up to 3 uuid re-rolls = at most 13 calls,
    // then throws — never an unbounded loop.
    let calls = 0;
    await expect(
      insertWithUniqueSlugRetry("Отдел продаж", async () => {
        calls++;
        throw conflictError();
      }),
    ).rejects.toBeDefined();
    // 1 base + 9 numbered + 3 uuid = 13
    expect(calls).toBe(13);
  });

  it("F3: a uuid-fallback collision is RE-ROLLED, not propagated (succeeds on a later uuid attempt)", async () => {
    // Make every numbered candidate AND the first uuid attempt collide, then succeed.
    let calls = 0;
    const got = await insertWithUniqueSlugRetry(
      "Отдел продаж",
      async (slug) => {
        calls++;
        // 1 base + 9 numbered = 10 collisions, then the 11th (first uuid) collides too,
        // the 12th (second uuid re-roll) succeeds.
        if (calls <= 11) throw conflictError();
        return { slug };
      },
    );
    expect(calls).toBe(12);
    expect(got.slug).toMatch(/^otdel-prodazh-[0-9a-f]{8}$/);
  });
});
