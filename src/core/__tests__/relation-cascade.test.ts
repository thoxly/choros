/**
 * src/core/__tests__/relation-cascade.test.ts — T-0463 [D8-G2].
 *
 * Unit tests for the relation-cascade primitive (resolveRelationTarget). PURE,
 * ZERO NETWORK / ZERO DB / ZERO COST.
 *
 * Invariants (spec §3.2):
 *  RC-1  relation → NON-existent app → decision='create' (cascade a new app).
 *  RC-2  relation → existing app (exact slug)  → decision='link' (dedup, no dup).
 *  RC-3  relation → existing app (exact name)  → decision='link' (dedup, no dup).
 *  RC-4  relation → AMBIGUOUS (two apps same name) → decision='ask' (no guess).
 *  RC-5  hop-cap: depth > HOP_CAP(3) → decision='hop_cap_exceeded' (chain stops).
 *  RC-6  explicit target id → decision='link' (the picker's existing-selection path).
 *  RC-7  create derives a Cyrillic-aware slug when only a name is given.
 */

import { describe, it, expect } from "vitest";
import {
  resolveRelationTarget,
  HOP_CAP,
  type RegistryDefCandidate,
} from "../relation-cascade.js";

const CONTRACTORS: RegistryDefCandidate = {
  id: "c0000000-0000-0000-0000-000000000001",
  slug: "contractors",
  displayName: "Контрагенты",
};
const PURCHASES: RegistryDefCandidate = {
  id: "c0000000-0000-0000-0000-000000000002",
  slug: "purchases",
  displayName: "Заявки на закупку",
};

describe("relation-cascade: resolveRelationTarget (T-0463 D8-G2)", () => {
  // RC-1: relation → non-existent app → CREATE in the same bundle.
  it("RC-1: target does not exist → decision='create' with a slug+name to cascade", () => {
    const d = resolveRelationTarget(
      { targetDisplayName: "Поставщики" },
      [CONTRACTORS, PURCHASES],
      1,
    );
    expect(d.decision).toBe("create");
    if (d.decision === "create") {
      expect(d.appDisplayName).toBe("Поставщики");
      expect(d.appSlug).toBe("postavschiki"); // Cyrillic-aware slug
      expect(d.depth).toBe(1);
    }
  });

  // RC-2: exact slug match → LINK (no duplicate app).
  it("RC-2: exact slug match → decision='link' to existing id (dedup, no duplicate)", () => {
    const d = resolveRelationTarget(
      { targetSlug: "contractors" },
      [CONTRACTORS, PURCHASES],
      1,
    );
    expect(d.decision).toBe("link");
    if (d.decision === "link") {
      expect(d.targetRegistryId).toBe(CONTRACTORS.id);
      expect(d.matchReason).toBe("exact_slug");
    }
  });

  // RC-3: exact (normalized) name match → LINK.
  it("RC-3: exact name match (case/space-insensitive) → decision='link' (dedup)", () => {
    const d = resolveRelationTarget(
      { targetDisplayName: "  контрагенты " },
      [CONTRACTORS, PURCHASES],
      1,
    );
    expect(d.decision).toBe("link");
    if (d.decision === "link") {
      expect(d.targetRegistryId).toBe(CONTRACTORS.id);
      expect(d.matchReason).toBe("exact_name");
    }
  });

  // RC-4: ambiguous (two apps share a normalized name) → ASK (no guess).
  it("RC-4: ambiguous name (two candidates) → decision='ask' with candidates", () => {
    const dup1: RegistryDefCandidate = { id: "d1", slug: "vendors-a", displayName: "Контрагенты" };
    const dup2: RegistryDefCandidate = { id: "d2", slug: "vendors-b", displayName: "контрагенты" };
    const d = resolveRelationTarget(
      { targetDisplayName: "Контрагенты" },
      [dup1, dup2, PURCHASES],
      1,
    );
    expect(d.decision).toBe("ask");
    if (d.decision === "ask") {
      expect(d.candidates).toHaveLength(2);
      expect(d.candidates.map((c) => c.id).sort()).toEqual(["d1", "d2"]);
      expect(d.question).toMatch(/уточните|создайте/i);
    }
  });

  // RC-5: hop-cap — a chain deeper than HOP_CAP stops (no runaway fan-out).
  it("RC-5: depth > HOP_CAP → decision='hop_cap_exceeded' (chain stops)", () => {
    const d = resolveRelationTarget(
      { targetDisplayName: "Новое-глубокое" },
      [],
      HOP_CAP + 1, // 4 > 3 → must stop
    );
    expect(d.decision).toBe("hop_cap_exceeded");
    if (d.decision === "hop_cap_exceeded") {
      expect(d.cap).toBe(HOP_CAP);
      expect(d.attemptedDepth).toBe(HOP_CAP + 1);
    }
  });

  it("RC-5b: depth == HOP_CAP → still CREATE (the cap is inclusive — exactly 3 deep allowed)", () => {
    const d = resolveRelationTarget({ targetDisplayName: "Третий-уровень" }, [], HOP_CAP);
    expect(d.decision).toBe("create");
  });

  // RC-6: explicit existing id → LINK (the visual picker's existing-selection path).
  it("RC-6: explicit target id → decision='link' (matchReason='explicit_id')", () => {
    const d = resolveRelationTarget(
      { explicitTargetRegistryId: PURCHASES.id, targetDisplayName: "anything" },
      [CONTRACTORS],
      1,
    );
    expect(d.decision).toBe("link");
    if (d.decision === "link") {
      expect(d.targetRegistryId).toBe(PURCHASES.id);
      expect(d.matchReason).toBe("explicit_id");
    }
  });

  // RC-7: slug preference — when an explicit slug is given for a NEW app, use it.
  it("RC-7: create uses the given slug when one is supplied (no slugify needed)", () => {
    const d = resolveRelationTarget(
      { targetSlug: "suppliers", targetDisplayName: "Поставщики" },
      [],
      1,
    );
    expect(d.decision).toBe("create");
    if (d.decision === "create") {
      expect(d.appSlug).toBe("suppliers");
      expect(d.appDisplayName).toBe("Поставщики");
    }
  });

  // Edge: HOP_CAP is the shared cross-app-ref cap (= 3), not a local fork.
  it("HOP_CAP equals 3 (shared with cross-app-ref read-time cap)", () => {
    expect(HOP_CAP).toBe(3);
  });
});
