/**
 * T-0095: SLA state model — deterministic boundary tests with an INJECTED clock.
 *
 * The whole point of the model is that warn/over are a pure function of (now, deadline,
 * total-window). These tests pin the boundaries exactly (at-threshold, just-past) using
 * explicit `now` values — never the wall clock — so the gate is reproducible.
 */
import { describe, it, expect } from "vitest";
import {
  slaState,
  warnWindowMs,
  remainingMin,
  SLA_WARN_FRACTION,
  SLA_WARN_FLOOR_MS,
  SLA_WARN_CEIL_MS,
} from "../http/sla.js";

const MIN = 60_000;

describe("warnWindowMs (T-0095)", () => {
  it("is WARN_FRACTION of the window when within the clamp band", () => {
    // 120-min window → 25% = 30 min, between floor (5) and ceil (60) → unclamped
    expect(warnWindowMs(120)).toBe(120 * MIN * SLA_WARN_FRACTION);
    expect(warnWindowMs(120)).toBe(30 * MIN);
  });

  it("clamps up to the floor for very short SLAs", () => {
    // 5-min window → 25% = 1.25 min < 5-min floor → floored
    expect(warnWindowMs(5)).toBe(SLA_WARN_FLOOR_MS);
  });

  it("clamps down to the ceiling for very long SLAs", () => {
    // 1440-min (24h) window → 25% = 6h >> 60-min ceil → capped
    expect(warnWindowMs(1440)).toBe(SLA_WARN_CEIL_MS);
  });

  it("treats non-positive / non-finite windows as zero → floor", () => {
    expect(warnWindowMs(0)).toBe(SLA_WARN_FLOOR_MS);
    expect(warnWindowMs(-10)).toBe(SLA_WARN_FLOOR_MS);
    expect(warnWindowMs(Number.NaN)).toBe(SLA_WARN_FLOOR_MS);
  });
});

describe("slaState boundaries (T-0095)", () => {
  // Fixed deadline; a 120-min window → 30-min warn zone.
  const deadline = 1_000_000_000;
  const totalMin = 120;
  const warnMs = warnWindowMs(totalMin); // 30 min

  it("is normal well before the warn zone", () => {
    expect(slaState(deadline - 60 * MIN, deadline, totalMin)).toBe("normal");
  });

  it("is normal one ms before the warn boundary", () => {
    expect(slaState(deadline - warnMs - 1, deadline, totalMin)).toBe("normal");
  });

  it("is warn EXACTLY at the warn boundary (now === deadline - warnWindow)", () => {
    expect(slaState(deadline - warnMs, deadline, totalMin)).toBe("warn");
  });

  it("is warn just inside the warn zone", () => {
    expect(slaState(deadline - 1 * MIN, deadline, totalMin)).toBe("warn");
  });

  it("is over EXACTLY at the deadline (now === deadline)", () => {
    expect(slaState(deadline, deadline, totalMin)).toBe("over");
  });

  it("is over just past the deadline", () => {
    expect(slaState(deadline + 1, deadline, totalMin)).toBe("over");
  });

  it("is normal just before deadline for a long SLA (ceil-clamped warn zone)", () => {
    // 24h window → warn zone capped at 60 min; 61 min out is still normal.
    expect(slaState(deadline - 61 * MIN, deadline, 1440)).toBe("normal");
    expect(slaState(deadline - 60 * MIN, deadline, 1440)).toBe("warn");
  });

  it("returns normal for non-finite inputs (defensive)", () => {
    expect(slaState(Number.NaN, deadline, totalMin)).toBe("normal");
    expect(slaState(deadline, Number.NaN, totalMin)).toBe("normal");
  });
});

describe("remainingMin (T-0095)", () => {
  it("computes whole minutes of headroom, truncating toward zero", () => {
    expect(remainingMin(0, 90 * MIN)).toBe(90);
    expect(remainingMin(0, 90 * MIN + 59_000)).toBe(90); // sub-minute truncated
  });

  it("is negative once past due", () => {
    expect(remainingMin(100 * MIN, 90 * MIN)).toBe(-10);
  });

  it("is zero exactly at the deadline", () => {
    expect(remainingMin(90 * MIN, 90 * MIN)).toBe(0);
  });
});
