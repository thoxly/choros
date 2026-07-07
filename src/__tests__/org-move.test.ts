/**
 * src/__tests__/org-move.test.ts — T-0655 [W5-UX / ux-study §6.4 + §1C]
 *
 * Unit tests for the PURE org-move helpers (src/core/org-move.ts): the department
 * reparent CYCLE GUARD and the *.moved audit-diff builders. DB-free — mirrors
 * sidebar-dnd.test.js (pure move-logic tested without the DOM/DB).
 *
 * The HTTP-level 200/400-CYCLE/403/404 flow through PATCH /api/{departments,
 * positions,employees}/:id lives in the DB-honest fitness probe
 * (ci/checks/db/org-move-api.mjs) — it needs a live Postgres.
 */

import { describe, it, expect } from "vitest";
import {
  wouldCreateCycle,
  isEmptyPatch,
  buildDeptMoveDiff,
  buildPositionMoveDiff,
  buildEmployeeMoveDiff,
} from "../core/org-move.js";

// A small tree:  root → a → b → c ;  root2 (separate root)
const parentOf = new Map<string, string | null>([
  ["root", null],
  ["a", "root"],
  ["b", "a"],
  ["c", "b"],
  ["root2", null],
]);

describe("wouldCreateCycle — department reparent guard", () => {
  it("becoming a root (parent=null) is always safe", () => {
    expect(wouldCreateCycle(parentOf, "a", null)).toBe(false);
    expect(wouldCreateCycle(parentOf, "c", null)).toBe(false);
  });

  it("self-parent is a cycle", () => {
    expect(wouldCreateCycle(parentOf, "a", "a")).toBe(true);
  });

  it("moving a node under its own direct child is a cycle", () => {
    // a's child is b — making b a's parent would loop.
    expect(wouldCreateCycle(parentOf, "a", "b")).toBe(true);
  });

  it("moving a node under a transitive descendant is a cycle", () => {
    // c is a's grandchild (a → b → c). Making c a's parent loops.
    expect(wouldCreateCycle(parentOf, "a", "c")).toBe(true);
  });

  it("moving a node under an unrelated subtree is safe", () => {
    // Move a (and its whole subtree) under root2 — no cycle.
    expect(wouldCreateCycle(parentOf, "a", "root2")).toBe(false);
  });

  it("moving a node under an ancestor is safe (no new cycle)", () => {
    // c is already under b→a→root; making c a child of root is a legal move up.
    expect(wouldCreateCycle(parentOf, "c", "root")).toBe(false);
  });

  it("tolerates a pre-existing corrupt cycle in the data without spinning", () => {
    const corrupt = new Map<string, string | null>([
      ["x", "y"],
      ["y", "x"], // x↔y cycle already in the data
      ["z", null],
    ]);
    // Must terminate and give an answer, not hang.
    expect(wouldCreateCycle(corrupt, "z", "x")).toBe(false);
    expect(wouldCreateCycle(corrupt, "x", "z")).toBe(false);
  });
});

describe("isEmptyPatch", () => {
  it("true for an empty object", () => {
    expect(isEmptyPatch({})).toBe(true);
  });
  it("false when any field is present (including explicit null)", () => {
    expect(isEmptyPatch({ parent_id: null })).toBe(false);
    expect(isEmptyPatch({ display_name: "X" })).toBe(false);
  });
});

describe("buildDeptMoveDiff — audit payload", () => {
  it("records only the touched fields (reparent only)", () => {
    const diff = buildDeptMoveDiff(
      { parent_id: "old", display_name: "Финансы" },
      { parent_id: "new" },
    );
    expect(diff).toEqual({ from_parent_id: "old", to_parent_id: "new" });
    expect("renamed" in diff).toBe(false);
  });

  it("records an explicit null reparent (→ root)", () => {
    const diff = buildDeptMoveDiff(
      { parent_id: "old", display_name: "X" },
      { parent_id: null },
    );
    expect(diff).toEqual({ from_parent_id: "old", to_parent_id: null });
  });

  it("records a rename with the renamed flag", () => {
    const diff = buildDeptMoveDiff(
      { parent_id: null, display_name: "Старое" },
      { display_name: "Новое" },
    );
    expect(diff).toEqual({ from_name: "Старое", to_name: "Новое", renamed: true });
  });

  it("records both reparent and rename together", () => {
    const diff = buildDeptMoveDiff(
      { parent_id: "old", display_name: "A" },
      { parent_id: "new", display_name: "B" },
    );
    expect(diff).toEqual({
      from_parent_id: "old", to_parent_id: "new",
      from_name: "A", to_name: "B", renamed: true,
    });
  });
});

describe("buildPositionMoveDiff — audit payload", () => {
  it("records department move + title rename", () => {
    const diff = buildPositionMoveDiff(
      { department_id: "d1", title: "Спец" },
      { department_id: "d2", title: "Ведущий спец" },
    );
    expect(diff).toEqual({
      from_department_id: "d1", to_department_id: "d2",
      from_title: "Спец", to_title: "Ведущий спец", renamed: true,
    });
  });
});

describe("buildEmployeeMoveDiff — audit payload", () => {
  it("records position move (including detach → null)", () => {
    const diff = buildEmployeeMoveDiff(
      { position_id: "p1", display_name: "Джо" },
      { position_id: null },
    );
    expect(diff).toEqual({ from_position_id: "p1", to_position_id: null });
  });

  it("records rename", () => {
    const diff = buildEmployeeMoveDiff(
      { position_id: null, display_name: "Джо" },
      { display_name: "Джон" },
    );
    expect(diff).toEqual({ from_name: "Джо", to_name: "Джон", renamed: true });
  });
});
