/**
 * T-0744 — pure unit tests for the coverage invariant (test (г), isolated).
 *
 * The invariant (one source of truth, ADR T-0729 §2.7/§3-в1, tech-debt item):
 *   a substitution rule provides COVERAGE of a role IFF it minted a Tier-2 grant
 *   (ttlGrantId !== null) OR the substitute personally holds the role
 *   (roleHolders.has(substituteEmployeeId)).
 *
 * These tests exercise substituteProvidesCoverage + computeEffectivePool with NO
 * DB / IO — the predicate is a pure function, testable in isolation (coder.md /
 * ADR requirement). No case-content: only synthetic role/employee slugs.
 */

import { describe, it, expect } from "vitest";
import {
  substituteProvidesCoverage,
  computeEffectivePool,
} from "../substitution.js";
import type { SubstitutionRule } from "../substitution.js";
import { BOTTOM } from "../grant-lattice.js";

// Minimal rule factory — only the fields the predicate/pool builder read matter
// for these pure tests; the rest are filled with inert values.
function rule(args: {
  absent: string;
  substitute: string;
  role: string;
  ttlGrantId: string | null;
}): SubstitutionRule {
  return {
    tenantId: "t",
    id: `rule-${args.absent}-${args.substitute}`,
    absentEmployeeId: args.absent,
    substituteEmployeeId: args.substitute,
    roleId: args.role,
    orgScope: BOTTOM,
    ttlGrantId: args.ttlGrantId,
    nonInheritableExcluded: false,
    proposedBy: null,
    confirmedBy: "c",
    validFrom: null,
    validUntil: null,
    source: "test",
    createdBy: "c",
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("substituteProvidesCoverage — the coverage invariant (pure)", () => {
  it("Tier-2 (ttlGrantId set) → coverage, regardless of holder membership", () => {
    const r = rule({ absent: "a", substitute: "s", role: "R", ttlGrantId: "g1" });
    expect(substituteProvidesCoverage(r, new Set())).toBe(true);
    expect(substituteProvidesCoverage(r, new Set(["a"]))).toBe(true);
  });

  it("Tier-1 (ttlGrantId null) + substitute IS a holder → coverage", () => {
    const r = rule({ absent: "a", substitute: "s", role: "R", ttlGrantId: null });
    expect(substituteProvidesCoverage(r, new Set(["s", "a"]))).toBe(true);
  });

  it("Tier-1 (ttlGrantId null) + substitute is NOT a holder → NO coverage (the T-0729 bug)", () => {
    const r = rule({ absent: "a", substitute: "s", role: "R", ttlGrantId: null });
    expect(substituteProvidesCoverage(r, new Set(["a"]))).toBe(false);
    expect(substituteProvidesCoverage(r, new Set())).toBe(false);
  });

  it("reads only ttlGrantId + substituteEmployeeId (structural: accepts a Pick)", () => {
    // Coverage decision must not depend on any other field.
    expect(
      substituteProvidesCoverage(
        { ttlGrantId: null, substituteEmployeeId: "s" },
        new Set(["s"]),
      ),
    ).toBe(true);
    expect(
      substituteProvidesCoverage(
        { ttlGrantId: null, substituteEmployeeId: "s" },
        new Set(["x"]),
      ),
    ).toBe(false);
  });
});

describe("computeEffectivePool — suppress-absent + coverage-gated re-add (pure)", () => {
  it("no rules → pool unchanged", () => {
    expect(computeEffectivePool(["a", "b"], [], "R").sort()).toEqual(["a", "b"]);
  });

  it("sole holder absent, Tier-1 non-holder substitute → empty pool (role_unfilled)", () => {
    const rules = [rule({ absent: "a", substitute: "s", role: "R", ttlGrantId: null })];
    expect(computeEffectivePool(["a"], rules, "R")).toEqual([]);
  });

  it("sole holder absent, Tier-2 substitute → substitute carries the pool", () => {
    const rules = [rule({ absent: "a", substitute: "s", role: "R", ttlGrantId: "g1" })];
    expect(computeEffectivePool(["a"], rules, "R")).toEqual(["s"]);
  });

  it("holder absent, substitute is a co-holder → substitute remains (coverage)", () => {
    const rules = [rule({ absent: "a", substitute: "b", role: "R", ttlGrantId: null })];
    // b already holds the role → after suppressing a, pool = {b}.
    expect(computeEffectivePool(["a", "b"], rules, "R")).toEqual(["b"]);
  });

  it("absent holder w/ non-covering sub + a second live holder → only the live holder", () => {
    const rules = [rule({ absent: "a", substitute: "s", role: "R", ttlGrantId: null })];
    // a suppressed, s not coverage (not a holder), c is a live holder → {c}.
    expect(computeEffectivePool(["a", "c"], rules, "R")).toEqual(["c"]);
  });

  it("rule for a DIFFERENT role is ignored (roleId must match)", () => {
    const rules = [rule({ absent: "a", substitute: "s", role: "OTHER", ttlGrantId: "g1" })];
    expect(computeEffectivePool(["a"], rules, "R")).toEqual(["a"]);
  });

  it("empty holders → empty pool", () => {
    const rules = [rule({ absent: "a", substitute: "s", role: "R", ttlGrantId: "g1" })];
    expect(computeEffectivePool([], rules, "R")).toEqual([]);
  });
});
