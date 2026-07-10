/**
 * T-0710 [E16, capstone T-0691 P2, bug #3] — pure unit tests for
 * stableSortEscalatedLast (src/http/inbox.ts).
 *
 * THE BUG (found live): GET /api/inbox's default (no `sort=`) ordering merges
 * defer rows (EVERY defer row is an escalation by construction, T-0638 F7)
 * BEFORE any instance row (`merged = [...dedupedDefer, ...dedupedInstance]`), so
 * agent escalations structurally dominate the front of the list. With the
 * default page size, older genuine approver-waiting tasks (non-escalated
 * instance rows) end up past the first page and are effectively invisible
 * unless the operator pages through.
 *
 * THE FIX: a STABLE partition — non-escalated items first, escalated items
 * last, original relative order preserved within each group — applied to the
 * default ordering (never to an explicit `sort=sla`, which is untouched: an
 * operator who asked for urgency-first keeps getting it).
 */

import { describe, it, expect } from "vitest";
import { stableSortEscalatedLast } from "../http/inbox.js";

// Minimal InboxItem-shaped fixtures — only the fields the sort/predicate read.
type ItemLike = Parameters<typeof stableSortEscalatedLast>[0][number];
function mk(partial: Partial<ItemLike> & { id: string }): ItemLike {
  return {
    status: "waiting",
    name: "",
    step: "",
    inst: "",
    role: "r",
    sla: { min: 60, left: 60 },
    due: "",
    ...partial,
  } as ItemLike;
}

describe("T-0710 stableSortEscalatedLast", () => {
  it("moves escalated items to the end, preserving relative order within each group (stable)", () => {
    const items = [
      mk({ id: "esc-1", escalated: true }),
      mk({ id: "plain-1" }),
      mk({ id: "esc-2", escalated: true }),
      mk({ id: "plain-2" }),
      mk({ id: "plain-3" }),
    ];
    const sorted = stableSortEscalatedLast(items).map((i) => i.id);
    expect(sorted).toEqual(["plain-1", "plain-2", "plain-3", "esc-1", "esc-2"]);
  });

  it("a status:failed item counts as escalated too (mirrors isEscalated)", () => {
    const items = [
      mk({ id: "failed-1", status: "failed" }),
      mk({ id: "plain-1" }),
    ];
    const sorted = stableSortEscalatedLast(items).map((i) => i.id);
    expect(sorted).toEqual(["plain-1", "failed-1"]);
  });

  it("all-escalated input is left in its original relative order (no-op partition — the esc tab)", () => {
    const items = [
      mk({ id: "esc-1", escalated: true }),
      mk({ id: "esc-2", escalated: true }),
      mk({ id: "esc-3", escalated: true }),
    ];
    const sorted = stableSortEscalatedLast(items).map((i) => i.id);
    expect(sorted).toEqual(["esc-1", "esc-2", "esc-3"]);
  });

  it("all-non-escalated input is left in its original relative order", () => {
    const items = [
      mk({ id: "p1" }),
      mk({ id: "p2" }),
      mk({ id: "p3" }),
    ];
    const sorted = stableSortEscalatedLast(items).map((i) => i.id);
    expect(sorted).toEqual(["p1", "p2", "p3"]);
  });

  it("does not mutate the input array (returns a new array)", () => {
    const items = [mk({ id: "esc-1", escalated: true }), mk({ id: "plain-1" })];
    const before = items.map((i) => i.id);
    stableSortEscalatedLast(items);
    expect(items.map((i) => i.id)).toEqual(before);
  });

  it("empty input → empty output", () => {
    expect(stableSortEscalatedLast([])).toEqual([]);
  });
});
