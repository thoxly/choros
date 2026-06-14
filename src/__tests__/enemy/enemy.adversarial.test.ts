/**
 * T-0154 · ВРАГ — deterministic adversarial property/fuzz suite + corpus replay.
 *
 * Эпик E-VRG / T-0151 «Враг». spec: playbooks/enemy-redteam-backlog.md §6.
 * Catalog: docs/design/T-0152-security-invariants-catalog.md.
 *
 * This is the CI entry point of the deterministic Enemy. It runs in the ordinary
 * `vitest run` flow (npm run ci) — no DB, no clock, no network — so it executes on
 * EVERY CI run and never flakes. Three layers:
 *
 *  (1) GENERATED FUZZ — a seeded stream of adversarial cases across the T-0152
 *      invariant families (TENANT-ISO, PDP-DENY, GRANT-ESCALATION, DEV-AUTH-PROD)
 *      run against the REAL surfaces; the system must hold (deny/isolate) for ALL.
 *  (2) CORPUS REPLAY — every confirmed attack ever recorded (append-only
 *      corpus/corpus.jsonl) is replayed against the REAL surfaces; a permanent
 *      regression — the system must forever deny each one.
 *  (3) SELF-TEST (the Enemy must be able to BITE) — the SAME generated cases are
 *      run against deliberately-BROKEN surfaces; the harness MUST report findings.
 *      An Enemy that cannot fail is worthless; this proves it detects real
 *      violations (allow-by-default PDP, tenant-blind PDP, dev-auth-in-prod).
 *  (4) DETERMINISM — the generator yields a byte-identical case stream across
 *      repeated runs with the same seed.
 */

import { describe, it, expect } from "vitest";
import {
  generateCases,
  runEnemy,
  runCase,
  type AttackCase,
} from "./enemy-harness.js";
import { realSurfaces, brokenSurfaces } from "./enemy-surfaces.js";
import { loadCorpus } from "./corpus.js";

// Fixed seed — the Enemy is deterministic. Changing the seed changes the case
// stream but never the verdict (the system must hold for ANY seed).
const ENEMY_FUZZ_KEY = 0xe9e0154; // fixed 32-bit constant ("E9E" ~ enemy, 0154 = task)
const PER_FAMILY = 24;

describe("ВРАГ (T-0154): deterministic generated fuzz — system must HOLD", () => {
  const cases = generateCases(ENEMY_FUZZ_KEY, PER_FAMILY);

  it(`generates a non-trivial, balanced case stream (${PER_FAMILY}/family)`, () => {
    expect(cases.length).toBe(PER_FAMILY * 4);
    const families = new Set(cases.map((c) => c.family));
    expect(families).toEqual(
      new Set(["TENANT-ISO", "PDP-DENY", "GRANT-ESCALATION", "DEV-AUTH-PROD"]),
    );
  });

  it("REAL surfaces hold against EVERY generated adversarial case (no findings)", async () => {
    const findings = await runEnemy(cases, realSurfaces);
    if (findings.length > 0) {
      const report = findings
        .map((f) => `  [${f.case.family}] ${f.case.id}\n     ${f.observed}`)
        .join("\n");
      throw new Error(
        `ВРАГ found ${findings.length} confirmed attack(s) — the system did NOT hold:\n${report}`,
      );
    }
    expect(findings.length).toBe(0);
  });

  // Per-family breakdown so a regression points at the exact invariant family.
  for (const family of [
    "TENANT-ISO",
    "PDP-DENY",
    "GRANT-ESCALATION",
    "DEV-AUTH-PROD",
  ] as const) {
    it(`family ${family}: REAL surface holds for all generated cases`, async () => {
      const fam = cases.filter((c) => c.family === family);
      expect(fam.length).toBeGreaterThan(0);
      const findings = await runEnemy(fam, realSurfaces);
      expect(findings.map((f) => `${f.case.id}: ${f.observed}`)).toEqual([]);
    });
  }
});

describe("ВРАГ (T-0154): append-only corpus replay — permanent regression", () => {
  const corpus = loadCorpus();

  it("corpus is non-empty (seeded with confirmed attacks)", () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  it("every corpus case still HELD: the system forever denies each recorded attack", async () => {
    const findings = await runEnemy(corpus, realSurfaces);
    if (findings.length > 0) {
      const report = findings
        .map((f) => `  [${f.case.family}] ${f.case.id}\n     ${f.observed}`)
        .join("\n");
      throw new Error(
        `REGRESSION — a recorded corpus attack is no longer denied:\n${report}`,
      );
    }
    expect(findings.length).toBe(0);
  });

  it("corpus covers each invariant family that the Enemy probes", () => {
    const families = new Set(corpus.map((c) => c.family));
    for (const f of [
      "TENANT-ISO",
      "PDP-DENY",
      "GRANT-ESCALATION",
      "DEV-AUTH-PROD",
    ] as const) {
      expect(families.has(f)).toBe(true);
    }
  });
});

describe("ВРАГ (T-0154): SELF-TEST — the Enemy MUST be able to bite", () => {
  // The whole value of an adversarial gate is that it catches a REAL violation.
  // We run the SAME generated cases against deliberately-broken surfaces and
  // assert the harness reports findings for each broken invariant.
  const cases = generateCases(ENEMY_FUZZ_KEY, PER_FAMILY);

  it("broken surfaces (allow-all PDP + dev-auth-in-prod) are CAUGHT (findings > 0)", async () => {
    const findings = await runEnemy(cases, brokenSurfaces);
    // Every single case targets an invariant the broken surfaces violate, so the
    // Enemy must flag (essentially) all of them.
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.length).toBe(cases.length);
  });

  it("self-test catches each invariant family's violation individually", async () => {
    for (const family of [
      "TENANT-ISO",
      "PDP-DENY",
      "GRANT-ESCALATION",
      "DEV-AUTH-PROD",
    ] as const) {
      const fam = cases.filter((c) => c.family === family);
      const findings = await runEnemy(fam, brokenSurfaces);
      if (findings.length === 0) {
        throw new Error(
          `SELF-TEST FAILURE: the Enemy did NOT catch the planted ${family} vulnerability — it cannot bite`,
        );
      }
      expect(findings.length).toBe(fam.length);
    }
  });

  it("a single allow-by-default case is reported with an explanatory observation", async () => {
    const c: AttackCase = cases.find((x) => x.family === "PDP-DENY")!;
    const finding = await runCase(c, brokenSurfaces);
    expect(finding).not.toBeNull();
    expect(finding!.observed).toMatch(/ALLOWED|allowed/);
  });
});

describe("ВРАГ (T-0154): determinism — same seed ⇒ byte-identical case stream", () => {
  it("generateCases is reproducible (deep-equal across two runs, same seed)", () => {
    const a = generateCases(ENEMY_FUZZ_KEY, PER_FAMILY);
    const b = generateCases(ENEMY_FUZZ_KEY, PER_FAMILY);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("the case-id sequence is stable (pins the exact generated order)", () => {
    const a = generateCases(ENEMY_FUZZ_KEY, PER_FAMILY).map((c) => c.id);
    const b = generateCases(ENEMY_FUZZ_KEY, PER_FAMILY).map((c) => c.id);
    expect(b).toEqual(a);
    // No duplicate ids in a single generation (each case is a distinct probe).
    expect(new Set(a).size).toBe(a.length);
  });

  it("a different seed yields a different stream (the generator actually varies)", () => {
    const a = generateCases(ENEMY_FUZZ_KEY, PER_FAMILY).map((c) => c.id);
    const c = generateCases(ENEMY_FUZZ_KEY + 1, PER_FAMILY).map((x) => x.id);
    expect(c).not.toEqual(a);
  });
});
