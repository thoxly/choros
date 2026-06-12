/**
 * T-0078 · E11.7 — Authoring Red-Lines Guard
 * Unit tests for classifyAuthoringOp + evaluateAuthoringRedLine.
 *
 * No DB, no network, no process.env — pure unit tests.
 * Covers AC-2..AC-13 (spec T-0078).
 */

import { describe, it, expect } from "vitest";
import {
  classifyAuthoringOp,
  evaluateAuthoringRedLine,
  type AuthoringOp,
  type AuthoringContext,
  type AuthoringRedLineConfirm,
} from "../core/authoring-redlines.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ctx(isCorePinned: boolean): AuthoringContext {
  return { isCorePinned };
}

function op(
  kind: AuthoringOp["kind"],
  fieldKey = "amount",
  oldSchema?: AuthoringOp["oldSchema"],
  newSchema?: AuthoringOp["newSchema"],
): AuthoringOp {
  return { kind, fieldKey, oldSchema, newSchema };
}

function confirm(statement: string, force = true): AuthoringRedLineConfirm {
  return { consequenceStatement: statement, force };
}

// ---------------------------------------------------------------------------
// AC-2 — add_field → non_destructive; evaluateAuthoringRedLine → allow
// ---------------------------------------------------------------------------

describe("AC-2 · add_field → non_destructive", () => {
  it("add_field non-core → non_destructive", () => {
    expect(classifyAuthoringOp(op("add_field"), ctx(false))).toBe("non_destructive");
  });

  it("add_field non-core → evaluateAuthoringRedLine allow(non_destructive)", () => {
    const result = evaluateAuthoringRedLine(op("add_field"), ctx(false));
    expect(result.verdict).toBe("allow");
    expect(result.classification).toBe("non_destructive");
  });

  it("add_field core-pinned → non_destructive (add is always safe)", () => {
    // Adding a field to a core entity is permitted (extend-not-replace)
    expect(classifyAuthoringOp(op("add_field"), ctx(true))).toBe("non_destructive");
  });
});

// ---------------------------------------------------------------------------
// AC-3 — drop_field non-core without confirm → deny
// ---------------------------------------------------------------------------

describe("AC-3 · drop_field non-core without confirm → deny(requires_confirm)", () => {
  it("drop_field non-core → destructive classification", () => {
    expect(classifyAuthoringOp(op("drop_field"), ctx(false))).toBe("destructive");
  });

  it("drop_field non-core without confirm → deny(requires_confirm)", () => {
    const result = evaluateAuthoringRedLine(op("drop_field"), ctx(false));
    expect(result.verdict).toBe("deny");
    if (result.verdict === "deny") {
      expect(result.reason).toBe("requires_confirm");
      expect(result.requiresConfirm).toBe(true);
      expect(result.classification).toBe("destructive");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-4 — drop_field non-core + valid confirm + force=true → allow(destructive)
// ---------------------------------------------------------------------------

describe("AC-4 · drop_field non-core + valid confirm → allow(destructive)", () => {
  it("drop_field + valid semantic confirm → allow(destructive)", () => {
    const c = confirm("поле amount будет удалено и все данные будут потеряны");
    const result = evaluateAuthoringRedLine(op("drop_field"), ctx(false), c);
    expect(result.verdict).toBe("allow");
    if (result.verdict === "allow") {
      expect(result.classification).toBe("destructive");
      if (result.classification === "destructive") {
        expect(result.confirmedConsequence).toBe(c.consequenceStatement);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC-5 — rename_field non-core without confirm → deny
// ---------------------------------------------------------------------------

describe("AC-5 · rename_field non-core without confirm → deny", () => {
  it("rename_field non-core → destructive classification", () => {
    expect(classifyAuthoringOp(op("rename_field"), ctx(false))).toBe("destructive");
  });

  it("rename_field non-core without confirm → deny(requires_confirm)", () => {
    const result = evaluateAuthoringRedLine(op("rename_field"), ctx(false));
    expect(result.verdict).toBe("deny");
    if (result.verdict === "deny") {
      expect(result.reason).toBe("requires_confirm");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-6 — change_type number→integer non-core without confirm → deny
// ---------------------------------------------------------------------------

describe("AC-6 · change_type lossy without confirm → deny", () => {
  it("number→integer non-core → destructive", () => {
    const o = op("change_type", "count", { type: "number" }, { type: "integer" });
    expect(classifyAuthoringOp(o, ctx(false))).toBe("destructive");
  });

  it("number→integer non-core without confirm → deny(requires_confirm)", () => {
    const o = op("change_type", "count", { type: "number" }, { type: "integer" });
    const result = evaluateAuthoringRedLine(o, ctx(false));
    expect(result.verdict).toBe("deny");
    if (result.verdict === "deny") {
      expect(result.reason).toBe("requires_confirm");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-7 — change_type number→integer + valid confirm → allow(destructive)
// ---------------------------------------------------------------------------

describe("AC-7 · change_type lossy + valid confirm → allow(destructive)", () => {
  it("number→integer + valid confirm → allow(destructive, confirmedConsequence)", () => {
    const o = op("change_type", "count", { type: "number" }, { type: "integer" });
    const c = confirm("поле count изменит тип, дробные значения будут потеряны");
    const result = evaluateAuthoringRedLine(o, ctx(false), c);
    expect(result.verdict).toBe("allow");
    if (result.verdict === "allow") {
      expect(result.classification).toBe("destructive");
      if (result.classification === "destructive") {
        expect(result.confirmedConsequence).toBe(c.consequenceStatement);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC-8 — drop_field core-pinned → deny(core_pinned) даже при force=true
// ---------------------------------------------------------------------------

describe("AC-8 · drop_field core-pinned → deny(core_pinned) even with force", () => {
  it("drop_field core-pinned → core_pinned classification", () => {
    expect(classifyAuthoringOp(op("drop_field"), ctx(true))).toBe("core_pinned");
  });

  it("drop_field core-pinned without confirm → deny(core_pinned)", () => {
    const result = evaluateAuthoringRedLine(op("drop_field"), ctx(true));
    expect(result.verdict).toBe("deny");
    if (result.verdict === "deny") {
      expect(result.reason).toBe("core_pinned");
      expect(result.requiresConfirm).toBe(false);
      expect(result.classification).toBe("core_pinned");
    }
  });

  it("drop_field core-pinned WITH force + valid confirm → still deny(core_pinned)", () => {
    const c = confirm("я точно знаю что делаю с этим системным полем", true);
    const result = evaluateAuthoringRedLine(op("drop_field"), ctx(true), c);
    expect(result.verdict).toBe("deny");
    if (result.verdict === "deny") {
      expect(result.reason).toBe("core_pinned");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-9 — rename_field core-pinned → deny(core_pinned)
// ---------------------------------------------------------------------------

describe("AC-9 · rename_field core-pinned → deny(core_pinned)", () => {
  it("rename_field core-pinned → core_pinned classification", () => {
    expect(classifyAuthoringOp(op("rename_field"), ctx(true))).toBe("core_pinned");
  });

  it("rename_field core-pinned → deny(core_pinned)", () => {
    const result = evaluateAuthoringRedLine(op("rename_field"), ctx(true));
    expect(result.verdict).toBe("deny");
    if (result.verdict === "deny") {
      expect(result.reason).toBe("core_pinned");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-10 — relabel core-pinned → non_destructive (soft op not blocked by pin)
// ---------------------------------------------------------------------------

describe("AC-10 · relabel core-pinned → non_destructive", () => {
  it("relabel core-pinned → non_destructive (soft ops not blocked)", () => {
    expect(classifyAuthoringOp(op("relabel"), ctx(true))).toBe("non_destructive");
  });

  it("relabel core-pinned → allow(non_destructive)", () => {
    const result = evaluateAuthoringRedLine(op("relabel"), ctx(true));
    expect(result.verdict).toBe("allow");
    expect(result.classification).toBe("non_destructive");
  });

  it("toggle_required core-pinned → non_destructive", () => {
    expect(classifyAuthoringOp(op("toggle_required"), ctx(true))).toBe("non_destructive");
  });
});

// ---------------------------------------------------------------------------
// AC-11 — enum_change widening → non_destructive
// ---------------------------------------------------------------------------

describe("AC-11 · enum_change widening → non_destructive", () => {
  it("enum widening (more values) → non_destructive", () => {
    const o = op(
      "enum_change",
      "status",
      { type: "string", enum: ["a", "b"] },
      { type: "string", enum: ["a", "b", "c"] },
    );
    expect(classifyAuthoringOp(o, ctx(false))).toBe("non_destructive");
  });

  it("enum same set → non_destructive", () => {
    const o = op(
      "enum_change",
      "status",
      { type: "string", enum: ["a", "b"] },
      { type: "string", enum: ["a", "b"] },
    );
    expect(classifyAuthoringOp(o, ctx(false))).toBe("non_destructive");
  });

  it("enum widening + core-pinned → non_destructive (widening is safe)", () => {
    const o = op(
      "enum_change",
      "status",
      { type: "string", enum: ["active"] },
      { type: "string", enum: ["active", "pending"] },
    );
    expect(classifyAuthoringOp(o, ctx(true))).toBe("non_destructive");
  });
});

// ---------------------------------------------------------------------------
// AC-12 — enum_change narrowing non-core without confirm → deny
// ---------------------------------------------------------------------------

describe("AC-12 · enum_change narrowing non-core without confirm → deny", () => {
  it("enum narrowing (fewer values) non-core → destructive", () => {
    const o = op(
      "enum_change",
      "status",
      { type: "string", enum: ["a", "b", "c"] },
      { type: "string", enum: ["a"] },
    );
    expect(classifyAuthoringOp(o, ctx(false))).toBe("destructive");
  });

  it("enum narrowing non-core without confirm → deny(requires_confirm)", () => {
    const o = op(
      "enum_change",
      "status",
      { type: "string", enum: ["a", "b", "c"] },
      { type: "string", enum: ["a"] },
    );
    const result = evaluateAuthoringRedLine(o, ctx(false));
    expect(result.verdict).toBe("deny");
    if (result.verdict === "deny") {
      expect(result.reason).toBe("requires_confirm");
    }
  });

  it("string → enum narrowing (open→closed) non-core → destructive", () => {
    const o = op(
      "change_type",
      "kind",
      { type: "string" },
      { type: "string", enum: ["foo", "bar"] },
    );
    expect(classifyAuthoringOp(o, ctx(false))).toBe("destructive");
  });
});

// ---------------------------------------------------------------------------
// AC-13 — confirm with consequenceStatement < 10 chars → deny(invalid_confirm)
// ---------------------------------------------------------------------------

describe("AC-13 · confirm with too-short consequenceStatement → deny(invalid_confirm)", () => {
  it("consequenceStatement < 10 chars → deny(invalid_confirm)", () => {
    const c: AuthoringRedLineConfirm = { consequenceStatement: "yes", force: true };
    const result = evaluateAuthoringRedLine(op("drop_field"), ctx(false), c);
    expect(result.verdict).toBe("deny");
    if (result.verdict === "deny") {
      expect(result.reason).toBe("invalid_confirm");
      expect(result.requiresConfirm).toBe(true);
    }
  });

  it("empty consequenceStatement → deny(invalid_confirm)", () => {
    const c: AuthoringRedLineConfirm = { consequenceStatement: "", force: true };
    const result = evaluateAuthoringRedLine(op("drop_field"), ctx(false), c);
    expect(result.verdict).toBe("deny");
    if (result.verdict === "deny") {
      expect(result.reason).toBe("invalid_confirm");
    }
  });

  it("exactly 9 chars → deny(invalid_confirm)", () => {
    const c: AuthoringRedLineConfirm = { consequenceStatement: "123456789", force: true };
    const result = evaluateAuthoringRedLine(op("drop_field"), ctx(false), c);
    expect(result.verdict).toBe("deny");
    if (result.verdict === "deny") {
      expect(result.reason).toBe("invalid_confirm");
    }
  });

  it("exactly 10 chars → allow (boundary)", () => {
    const c: AuthoringRedLineConfirm = { consequenceStatement: "1234567890", force: true };
    const result = evaluateAuthoringRedLine(op("drop_field"), ctx(false), c);
    expect(result.verdict).toBe("allow");
  });

  it("confirm with force=false → deny(invalid_confirm) even if text is long enough", () => {
    const c: AuthoringRedLineConfirm = {
      consequenceStatement: "поле amount будет удалено, данные потеряны",
      force: false,
    };
    const result = evaluateAuthoringRedLine(op("drop_field"), ctx(false), c);
    expect(result.verdict).toBe("deny");
    if (result.verdict === "deny") {
      expect(result.reason).toBe("invalid_confirm");
    }
  });
});

// ---------------------------------------------------------------------------
// Additional: non_destructive soft ops
// ---------------------------------------------------------------------------

describe("Soft operations: relabel + toggle_required → non_destructive", () => {
  it("relabel non-core → non_destructive, allow without confirm", () => {
    const result = evaluateAuthoringRedLine(op("relabel"), ctx(false));
    expect(result.verdict).toBe("allow");
    expect(result.classification).toBe("non_destructive");
  });

  it("toggle_required non-core → non_destructive, allow without confirm", () => {
    const result = evaluateAuthoringRedLine(op("toggle_required"), ctx(false));
    expect(result.verdict).toBe("allow");
    expect(result.classification).toBe("non_destructive");
  });
});

// ---------------------------------------------------------------------------
// Additional: type change non-lossy → non_destructive
// ---------------------------------------------------------------------------

describe("change_type non-lossy → non_destructive", () => {
  it("number stays number (no change) → non_destructive", () => {
    const o = op("change_type", "amount", { type: "number" }, { type: "number" });
    expect(classifyAuthoringOp(o, ctx(false))).toBe("non_destructive");
  });

  it("integer → number (widening) → non_destructive", () => {
    const o = op("change_type", "count", { type: "integer" }, { type: "number" });
    expect(classifyAuthoringOp(o, ctx(false))).toBe("non_destructive");
  });

  it("change_type without schemas → non_destructive (conservative default)", () => {
    const o = op("change_type", "x");
    expect(classifyAuthoringOp(o, ctx(false))).toBe("non_destructive");
  });
});

// ---------------------------------------------------------------------------
// Additional: mixed scenarios
// ---------------------------------------------------------------------------

describe("Mixed: core-pinned lossy → core_pinned (not just destructive)", () => {
  it("change_type number→integer core-pinned → core_pinned (not destructive)", () => {
    const o = op("change_type", "count", { type: "number" }, { type: "integer" });
    expect(classifyAuthoringOp(o, ctx(true))).toBe("core_pinned");
  });

  it("enum narrowing core-pinned → core_pinned", () => {
    const o = op(
      "enum_change",
      "status",
      { type: "string", enum: ["a", "b"] },
      { type: "string", enum: ["a"] },
    );
    expect(classifyAuthoringOp(o, ctx(true))).toBe("core_pinned");
  });
});
