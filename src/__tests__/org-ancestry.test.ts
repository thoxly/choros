// T-0515 — pure unit tests for the org-ancestry map-building + shared walk.
//
// No DB: exercises buildChildrenMap (adjacency from id/parent_id rows) and the
// shared traversal makeOrgAncestryOracle directly. These prove the containment
// semantics in isolation from Postgres; the DB round-trip is covered by the
// ci/checks/db/org-ancestry.db.test.ts probe.

import { describe, it, expect } from "vitest";
import { __test } from "../db/org-ancestry.js";
import { makeOrgAncestryOracle, SEED_ORACLE } from "../http/seed-ancestry.js";

const { buildChildrenMap } = __test;

describe("buildChildrenMap", () => {
  it("builds ancestor→children adjacency from id/parent_id rows", () => {
    // A→B→C, A→D
    const rows = [
      { id: "A", parent_id: null },
      { id: "B", parent_id: "A" },
      { id: "C", parent_id: "B" },
      { id: "D", parent_id: "A" },
    ];
    const map = buildChildrenMap(rows);
    expect(new Set(map.get("A"))).toEqual(new Set(["B", "D"]));
    expect(map.get("B")).toEqual(["C"]);
    expect(map.get("C")).toEqual([]); // leaf present as a key, no children
    expect(map.get("D")).toEqual([]);
  });

  it("tolerates a child row appearing before its parent row", () => {
    // Out-of-order: child C (parent B) listed before B exists as a key.
    const rows = [
      { id: "C", parent_id: "B" },
      { id: "B", parent_id: "A" },
      { id: "A", parent_id: null },
    ];
    const map = buildChildrenMap(rows);
    expect(map.get("A")).toEqual(["B"]);
    expect(map.get("B")).toEqual(["C"]);
  });

  it("a parent referenced but not present as its own row still records the child", () => {
    // Defensive: parent_id 'X' has no row of its own (shouldn't happen with FK,
    // but the map must not drop the edge).
    const rows = [{ id: "Y", parent_id: "X" }];
    const map = buildChildrenMap(rows);
    expect(map.get("X")).toEqual(["Y"]);
  });
});

describe("makeOrgAncestryOracle — shared traversal", () => {
  const map = buildChildrenMap([
    { id: "A", parent_id: null },
    { id: "B", parent_id: "A" },
    { id: "C", parent_id: "B" },
    { id: "D", parent_id: "A" },
  ]);
  const oracle = makeOrgAncestryOracle(map);

  it("self is descendant-or-self", () => {
    expect(oracle.isDescendantOrSelf("org", "A", "A")).toBe(true);
    expect(oracle.isDescendantOrSelf("org", "C", "C")).toBe(true);
  });

  it("ancestor covers deep descendant (A covers C)", () => {
    expect(oracle.isDescendantOrSelf("org", "C", "A")).toBe(true);
    expect(oracle.isDescendantOrSelf("org", "B", "A")).toBe(true);
    expect(oracle.isDescendantOrSelf("org", "D", "A")).toBe(true);
  });

  it("descendant does NOT cover ancestor (C does not cover A)", () => {
    expect(oracle.isDescendantOrSelf("org", "A", "C")).toBe(false);
  });

  it("sibling subtrees are incomparable (B does not cover D)", () => {
    expect(oracle.isDescendantOrSelf("org", "D", "B")).toBe(false);
    expect(oracle.isDescendantOrSelf("org", "C", "D")).toBe(false);
  });

  it("unknown ids → false", () => {
    expect(oracle.isDescendantOrSelf("org", "Z", "A")).toBe(false);
    expect(oracle.isDescendantOrSelf("org", "A", "Z")).toBe(false);
  });

  it("cycle-safe: a malformed cyclic map does not loop forever", () => {
    // P↔Q cycle; R reachable from P. The visited-set guards termination.
    const cyclic = new Map<string, string[]>([
      ["P", ["Q", "R"]],
      ["Q", ["P"]],
      ["R", []],
    ]);
    const o = makeOrgAncestryOracle(cyclic);
    expect(o.isDescendantOrSelf("org", "R", "P")).toBe(true);
    expect(o.isDescendantOrSelf("org", "P", "Q")).toBe(true); // Q→P
    expect(o.isDescendantOrSelf("org", "Z", "P")).toBe(false); // terminates, no Z
  });

  it("accepts a plain object map (Record) — same semantics as SEED_ORACLE", () => {
    const o = makeOrgAncestryOracle({ root: ["child"], child: [] });
    expect(o.isDescendantOrSelf("org", "child", "root")).toBe(true);
    expect(o.isDescendantOrSelf("org", "root", "child")).toBe(false);
    // SEED_ORACLE (the dev-seed fixture) still answers self-match correctly.
    expect(SEED_ORACLE.isDescendantOrSelf("org", "fin", "fin")).toBe(true);
    expect(SEED_ORACLE.isDescendantOrSelf("org", "fin-calc", "fin")).toBe(true);
  });
});
