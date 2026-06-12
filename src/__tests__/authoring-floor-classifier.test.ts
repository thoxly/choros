/**
 * T-0074 · E11.3 — Authoring Floor Classifier
 * Unit tests for classifyAuthoringFloor.
 *
 * AC coverage (§9.2 extensibility-and-authoring.md + §4):
 *   AC-1  — Floor-1 kinds → requiredFloor:'1' (all FLOOR1_EDIT_KINDS vocab)
 *   AC-2  — Floor-2 kinds → requiredFloor:'2' (all FLOOR2_EDIT_KINDS vocab)
 *   AC-3  — Unknown kind → requiredFloor:'2' (safe default)
 *   AC-4  — fieldKey present → appears in reason string
 *   AC-5  — fieldKey absent → no error, reason still valid
 *   AC-6  — meta field is ignored (purity: never affects result)
 *   AC-7  — result.reason is a non-empty string for all cases
 *   AC-8  — FLOOR1_EDIT_KINDS ∩ FLOOR2_EDIT_KINDS = ∅ (no overlap in vocab sets)
 *   AC-9  — All Floor-1 kinds individually covered (exhaustive by kind)
 *   AC-10 — All Floor-2 kinds individually covered (exhaustive by kind)
 *   AC-11 — Purity: executes synchronously, never throws, no I/O
 *   AC-12 — Adversarial inputs (null-ish kinds) → Floor-2, no throw
 *
 * No DB, no network, no process.env — pure unit tests.
 */

import { describe, it, expect } from "vitest";
import {
  classifyAuthoringFloor,
  FLOOR1_EDIT_KINDS,
  FLOOR2_EDIT_KINDS,
  type FormEditChange,
  type FormEditKind,
  type Floor1EditKind,
  type Floor2EditKind,
} from "../core/authoring-floor-classifier.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function change(kind: FormEditKind, fieldKey?: string): FormEditChange {
  return { kind, ...(fieldKey != null ? { fieldKey } : {}) };
}

function changeWithMeta(kind: FormEditKind, meta: Record<string, unknown>): FormEditChange {
  return { kind, meta };
}

// ---------------------------------------------------------------------------
// AC-1 — All Floor-1 kinds → requiredFloor:'1'
// ---------------------------------------------------------------------------

describe("AC-1 — Floor-1 kinds → requiredFloor:'1'", () => {
  const floor1Kinds: Floor1EditKind[] = [
    "relabel_field",
    "toggle_required",
    "hide_field",
    "show_field",
    "reorder_fields",
    "set_help_text",
  ];

  for (const kind of floor1Kinds) {
    it(`kind:'${kind}' → Floor-1`, () => {
      const result = classifyAuthoringFloor(change(kind));
      expect(result.requiredFloor).toBe("1");
    });
  }

  it("all Floor-1 kinds in FLOOR1_EDIT_KINDS are Floor-1", () => {
    for (const kind of FLOOR1_EDIT_KINDS) {
      const result = classifyAuthoringFloor(change(kind));
      expect(result.requiredFloor, `kind:${kind}`).toBe("1");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-2 — All Floor-2 kinds → requiredFloor:'2'
// ---------------------------------------------------------------------------

describe("AC-2 — Floor-2 kinds → requiredFloor:'2'", () => {
  const floor2Kinds: Floor2EditKind[] = [
    "add_field",
    "drop_field",
    "rename_field",
    "type_change",
    "add_conditional",
    "custom_component",
    "external_task",
    "object_migration",
  ];

  for (const kind of floor2Kinds) {
    it(`kind:'${kind}' → Floor-2`, () => {
      const result = classifyAuthoringFloor(change(kind));
      expect(result.requiredFloor).toBe("2");
    });
  }

  it("all Floor-2 kinds in FLOOR2_EDIT_KINDS are Floor-2", () => {
    for (const kind of FLOOR2_EDIT_KINDS) {
      const result = classifyAuthoringFloor(change(kind));
      expect(result.requiredFloor, `kind:${kind}`).toBe("2");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-3 — Unknown kind → requiredFloor:'2' (safe default)
// ---------------------------------------------------------------------------

describe("AC-3 — Unknown kind → requiredFloor:'2' (safe default)", () => {
  it("kind:'custom_widget' (unknown) → Floor-2", () => {
    // Cast needed: intentionally testing unknown kind
    const result = classifyAuthoringFloor({ kind: "custom_widget" as FormEditKind });
    expect(result.requiredFloor).toBe("2");
  });

  it("kind:'bulk_import' (unknown) → Floor-2", () => {
    const result = classifyAuthoringFloor({ kind: "bulk_import" as FormEditKind });
    expect(result.requiredFloor).toBe("2");
  });

  it("kind:'' (empty string) → Floor-2", () => {
    const result = classifyAuthoringFloor({ kind: "" as FormEditKind });
    expect(result.requiredFloor).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// AC-4 — fieldKey present → appears in reason string
// ---------------------------------------------------------------------------

describe("AC-4 — fieldKey present → appears in reason string", () => {
  it("Floor-1 with fieldKey → fieldKey in reason", () => {
    const result = classifyAuthoringFloor(change("relabel_field", "contract_name"));
    expect(result.requiredFloor).toBe("1");
    expect(result.reason).toContain("contract_name");
  });

  it("Floor-2 with fieldKey → fieldKey in reason", () => {
    const result = classifyAuthoringFloor(change("drop_field", "amount"));
    expect(result.requiredFloor).toBe("2");
    expect(result.reason).toContain("amount");
  });

  it("unknown kind with fieldKey → fieldKey in reason", () => {
    const result = classifyAuthoringFloor({ kind: "unknown_op" as FormEditKind, fieldKey: "ref_id" });
    expect(result.requiredFloor).toBe("2");
    expect(result.reason).toContain("ref_id");
  });
});

// ---------------------------------------------------------------------------
// AC-5 — fieldKey absent → no error, reason still valid
// ---------------------------------------------------------------------------

describe("AC-5 — fieldKey absent → no error, reason valid", () => {
  it("relabel_field without fieldKey → Floor-1, valid reason", () => {
    const result = classifyAuthoringFloor(change("relabel_field"));
    expect(result.requiredFloor).toBe("1");
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("add_field without fieldKey → Floor-2, valid reason", () => {
    const result = classifyAuthoringFloor(change("add_field"));
    expect(result.requiredFloor).toBe("2");
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("reason does not contain '(field:' when fieldKey is absent", () => {
    const result = classifyAuthoringFloor(change("reorder_fields"));
    expect(result.reason).not.toContain("(field:");
  });
});

// ---------------------------------------------------------------------------
// AC-6 — meta is ignored (purity: never affects result)
// ---------------------------------------------------------------------------

describe("AC-6 — meta field is ignored (purity)", () => {
  it("same kind + different meta → same requiredFloor", () => {
    const r1 = classifyAuthoringFloor(changeWithMeta("relabel_field", { agentId: "agent-1" }));
    const r2 = classifyAuthoringFloor(changeWithMeta("relabel_field", { agentId: "agent-2", draftId: "d-42" }));
    expect(r1.requiredFloor).toBe("1");
    expect(r2.requiredFloor).toBe("1");
    expect(r1.requiredFloor).toBe(r2.requiredFloor);
  });

  it("Floor-2 kind + meta → Floor-2 regardless of meta content", () => {
    const result = classifyAuthoringFloor(
      changeWithMeta("add_field", { source: "config-agent", budget: 100 }),
    );
    expect(result.requiredFloor).toBe("2");
  });

  it("meta=undefined (absent) vs meta={} → same result", () => {
    const r1 = classifyAuthoringFloor({ kind: "hide_field" });
    const r2 = classifyAuthoringFloor({ kind: "hide_field", meta: {} });
    expect(r1.requiredFloor).toBe(r2.requiredFloor);
    expect(r1.requiredFloor).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// AC-7 — result.reason is a non-empty string for all cases
// ---------------------------------------------------------------------------

describe("AC-7 — result.reason is non-empty string", () => {
  const allKinds: FormEditKind[] = [
    "relabel_field",
    "toggle_required",
    "hide_field",
    "show_field",
    "reorder_fields",
    "set_help_text",
    "add_field",
    "drop_field",
    "rename_field",
    "type_change",
    "add_conditional",
    "custom_component",
    "external_task",
    "object_migration",
  ];

  for (const kind of allKinds) {
    it(`kind:'${kind}' → reason is non-empty string`, () => {
      const result = classifyAuthoringFloor(change(kind));
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// AC-8 — FLOOR1_EDIT_KINDS ∩ FLOOR2_EDIT_KINDS = ∅ (vocab sets disjoint)
// ---------------------------------------------------------------------------

describe("AC-8 — FLOOR1_EDIT_KINDS and FLOOR2_EDIT_KINDS are disjoint", () => {
  it("no kind appears in both sets", () => {
    const floor1 = Array.from(FLOOR1_EDIT_KINDS);
    const overlap = floor1.filter((k) => (FLOOR2_EDIT_KINDS as ReadonlySet<string>).has(k));
    expect(overlap).toHaveLength(0);
  });

  it("FLOOR1_EDIT_KINDS has at least 1 kind", () => {
    expect(FLOOR1_EDIT_KINDS.size).toBeGreaterThan(0);
  });

  it("FLOOR2_EDIT_KINDS has at least 1 kind", () => {
    expect(FLOOR2_EDIT_KINDS.size).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC-9 — All Floor-1 kinds individually: correct requiredFloor + reason content
// ---------------------------------------------------------------------------

describe("AC-9 — Floor-1 kinds individually: requiredFloor + reason contains kind", () => {
  it("relabel_field → '1', reason mentions 'relabel_field'", () => {
    const r = classifyAuthoringFloor(change("relabel_field"));
    expect(r.requiredFloor).toBe("1");
    expect(r.reason).toContain("relabel_field");
  });

  it("toggle_required → '1', reason mentions 'toggle_required'", () => {
    const r = classifyAuthoringFloor(change("toggle_required"));
    expect(r.requiredFloor).toBe("1");
    expect(r.reason).toContain("toggle_required");
  });

  it("hide_field → '1', reason mentions 'hide_field'", () => {
    const r = classifyAuthoringFloor(change("hide_field"));
    expect(r.requiredFloor).toBe("1");
    expect(r.reason).toContain("hide_field");
  });

  it("show_field → '1', reason mentions 'show_field'", () => {
    const r = classifyAuthoringFloor(change("show_field"));
    expect(r.requiredFloor).toBe("1");
    expect(r.reason).toContain("show_field");
  });

  it("reorder_fields → '1', reason mentions 'reorder_fields'", () => {
    const r = classifyAuthoringFloor(change("reorder_fields"));
    expect(r.requiredFloor).toBe("1");
    expect(r.reason).toContain("reorder_fields");
  });

  it("set_help_text → '1', reason mentions 'set_help_text' (ADR §9.1 sixth Floor-1 op)", () => {
    // ADR §9.1 + T-0073: help-text is a first-class Floor-1 button operation,
    // distinct from relabel_field. T-0073 emits set_help_text — must NOT fall
    // through to unknown→Floor-2 (R-1 fix, review 2026-06-12).
    const r = classifyAuthoringFloor(change("set_help_text", "description"));
    expect(r.requiredFloor).toBe("1");
    expect(r.reason).toContain("set_help_text");
  });

  it("set_help_text without fieldKey → Floor-1, valid reason", () => {
    const r = classifyAuthoringFloor(change("set_help_text"));
    expect(r.requiredFloor).toBe("1");
    expect(typeof r.reason).toBe("string");
    expect(r.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC-10 — All Floor-2 kinds individually: correct requiredFloor + reason content
// ---------------------------------------------------------------------------

describe("AC-10 — Floor-2 kinds individually: requiredFloor + reason contains kind", () => {
  it("add_field → '2', reason mentions 'add_field'", () => {
    const r = classifyAuthoringFloor(change("add_field"));
    expect(r.requiredFloor).toBe("2");
    expect(r.reason).toContain("add_field");
  });

  it("drop_field → '2', reason mentions 'drop_field'", () => {
    const r = classifyAuthoringFloor(change("drop_field"));
    expect(r.requiredFloor).toBe("2");
    expect(r.reason).toContain("drop_field");
  });

  it("rename_field → '2', reason mentions 'rename_field'", () => {
    const r = classifyAuthoringFloor(change("rename_field"));
    expect(r.requiredFloor).toBe("2");
    expect(r.reason).toContain("rename_field");
  });

  it("type_change → '2', reason mentions 'type_change'", () => {
    const r = classifyAuthoringFloor(change("type_change"));
    expect(r.requiredFloor).toBe("2");
    expect(r.reason).toContain("type_change");
  });

  it("add_conditional → '2', reason mentions 'add_conditional'", () => {
    const r = classifyAuthoringFloor(change("add_conditional"));
    expect(r.requiredFloor).toBe("2");
    expect(r.reason).toContain("add_conditional");
  });

  it("custom_component → '2', reason mentions 'custom_component'", () => {
    const r = classifyAuthoringFloor(change("custom_component"));
    expect(r.requiredFloor).toBe("2");
    expect(r.reason).toContain("custom_component");
  });

  it("external_task → '2', reason mentions 'external_task'", () => {
    const r = classifyAuthoringFloor(change("external_task"));
    expect(r.requiredFloor).toBe("2");
    expect(r.reason).toContain("external_task");
  });

  it("object_migration → '2', reason mentions 'object_migration'", () => {
    const r = classifyAuthoringFloor(change("object_migration"));
    expect(r.requiredFloor).toBe("2");
    expect(r.reason).toContain("object_migration");
  });
});

// ---------------------------------------------------------------------------
// AC-11 — Purity: synchronous, never throws, no I/O
// ---------------------------------------------------------------------------

describe("AC-11 — Purity: synchronous, never throws, no I/O needed", () => {
  it("executes synchronously without throwing for Floor-1 input", () => {
    let result: ReturnType<typeof classifyAuthoringFloor> | undefined;
    expect(() => {
      result = classifyAuthoringFloor(change("relabel_field", "amount"));
    }).not.toThrow();
    expect(result?.requiredFloor).toBe("1");
  });

  it("executes synchronously without throwing for Floor-2 input", () => {
    let result: ReturnType<typeof classifyAuthoringFloor> | undefined;
    expect(() => {
      result = classifyAuthoringFloor(change("add_field", "new_field"));
    }).not.toThrow();
    expect(result?.requiredFloor).toBe("2");
  });

  it("return value is synchronous (not a Promise)", () => {
    const result = classifyAuthoringFloor(change("toggle_required", "status"));
    // If it were a Promise, result.requiredFloor would be undefined
    expect(result.requiredFloor).toBe("1");
    // AuthoringFloorResult has no 'then' — not a thenable
    expect("then" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-12 — Adversarial inputs: unknown kinds → Floor-2, no throw
// ---------------------------------------------------------------------------

describe("AC-12 — Adversarial inputs → Floor-2, no throw", () => {
  const adversarialKinds = [
    "",
    "RELABEL_FIELD",  // wrong case
    "floor1",
    "floor2",
    "unknown",
    "undefined",
    "null",
    "drop",           // truncated
    "add",            // truncated
    "relabel-field",  // dashes instead of underscores
    "custom component", // spaces
  ];

  for (const kind of adversarialKinds) {
    it(`adversarial kind:'${kind}' → Floor-2, no throw`, () => {
      expect(() => {
        const result = classifyAuthoringFloor({ kind: kind as FormEditKind });
        expect(result.requiredFloor).toBe("2");
        expect(typeof result.reason).toBe("string");
        expect(result.reason.length).toBeGreaterThan(0);
      }).not.toThrow();
    });
  }
});

// ---------------------------------------------------------------------------
// Integration: §9.2 invariant — lowest sufficient floor is always assigned
// ---------------------------------------------------------------------------

describe("§9.2 invariant — lowest sufficient floor", () => {
  it("relabeling is never escalated to Floor-2", () => {
    // §9.2: «каждая правка маршрутизируется на САМЫЙ НИЗКИЙ достаточный этаж»
    const result = classifyAuthoringFloor(change("relabel_field", "amount"));
    expect(result.requiredFloor).toBe("1");
  });

  it("adding a new field is never lowered to Floor-1", () => {
    // New field = new named-binding = structural = Floor-2
    const result = classifyAuthoringFloor(change("add_field", "new_key"));
    expect(result.requiredFloor).toBe("2");
  });

  it("drop_field is always Floor-2 (RED-LINE, human-gate)", () => {
    // §4: деструктив всегда Floor-2 + red-line human-gate
    const result = classifyAuthoringFloor(change("drop_field", "amount"));
    expect(result.requiredFloor).toBe("2");
  });

  it("rename_field is always Floor-2 (equivalent to drop+add)", () => {
    const result = classifyAuthoringFloor(change("rename_field", "old_key"));
    expect(result.requiredFloor).toBe("2");
  });

  it("toggle_required is Floor-1 (config-primary, zero-LLM)", () => {
    const result = classifyAuthoringFloor(change("toggle_required", "email"));
    expect(result.requiredFloor).toBe("1");
  });

  it("custom_component is always Floor-2 (sandbox-iframe territory)", () => {
    const result = classifyAuthoringFloor(change("custom_component", "rich_editor"));
    expect(result.requiredFloor).toBe("2");
  });
});
