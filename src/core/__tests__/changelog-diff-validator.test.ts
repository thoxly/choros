/**
 * T-0084 · E12.3 — Unit tests for changelog-diff-validator.ts
 *
 * Coverage:
 *   VALIDATOR-1   Faithful changelog + no schema change → promote-safe
 *   VALIDATOR-2   Changelog omits a changed member → blocked
 *   VALIDATOR-3   Changelog claims a spurious (unchanged) member → blocked
 *   VALIDATOR-4   Changelog kind mismatch (claims "added", actual "updated") → blocked
 *   VALIDATOR-5   Duplicate member in claimed changelog → blocked
 *   VALIDATOR-6   Lossy schema change (field drop with active aggregate dep) → blocked
 *   VALIDATOR-7   Additive schema change (new field) → promote-safe with no block
 *   VALIDATOR-8   Soft schema narrowing (read dep) → promote-safe with warning
 *   VALIDATOR-9   Malformed form_json_schema → blocked
 *   VALIDATOR-10  No changes at all + empty changelog → promote-safe
 *   VALIDATOR-11  Empty snapshot (genesis) → all members added, claimed correctly → safe
 *   VALIDATOR-12  diffBundleSnapshots independent of deriveSemanticChangelog (cross-check)
 *   VALIDATOR-13  form_json_schema array → blocked (must be object)
 *   VALIDATOR-14  form_json_schema valid empty string → safe (deferred member)
 *   VALIDATOR-15  object_schema unparseable → blocked
 */

import { describe, it, expect } from "vitest";
import {
  validateChangelog,
  diffBundleSnapshots,
  type ClaimedChange,
  type ValidateChangelogInput,
} from "../changelog-diff-validator.js";
import type { BundleSnapshot } from "../bundle-commit.js";
import type { AffectedDep } from "../schema-change-classifier.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EMPTY_SNAPSHOT: BundleSnapshot = {
  object_schema: "",
  grants: "",
  bpmn_process: "",
  form_code: "",
  form_json_schema: "",
};

const SNAPSHOT_V1: BundleSnapshot = {
  object_schema: '{"type":"object","properties":{"name":{"type":"string"}}}',
  grants: '[{"resource_type":"record","action":"read"}]',
  bpmn_process: '<process id="p1"/>',
  form_code: "",
  form_json_schema: "",
};

const SNAPSHOT_V2: BundleSnapshot = {
  object_schema: '{"type":"object","properties":{"name":{"type":"string"},"age":{"type":"number"}}}',
  grants: '[{"resource_type":"record","action":"read"},{"resource_type":"record","action":"write"}]',
  bpmn_process: '<process id="p1"/>',
  form_code: "export const Form = () => null;",
  form_json_schema: '{"type":"object","properties":{"name":{"type":"string"}}}',
};

/** Build a complete input object with sensible defaults. */
function makeInput(overrides: Partial<ValidateChangelogInput>): ValidateChangelogInput {
  return {
    fromSnapshot: SNAPSHOT_V1,
    toSnapshot: SNAPSHOT_V2,
    claimedChangelog: [],
    activeDeps: [],
    ...overrides,
  };
}

/** A correct changelog for SNAPSHOT_V1 → SNAPSHOT_V2 diff. */
const CORRECT_V1_TO_V2_CHANGELOG: ClaimedChange[] = [
  { member: "object_schema", kind: "updated" },
  { member: "grants", kind: "updated" },
  { member: "form_code", kind: "added" },
  { member: "form_json_schema", kind: "added" },
];

// ---------------------------------------------------------------------------
// VALIDATOR-1: Faithful changelog + no schema issue → promote-safe
// ---------------------------------------------------------------------------
describe("VALIDATOR-1: faithful changelog → promote-safe", () => {
  it("correctly stated changelog for V1→V2 diff produces promote-safe verdict", () => {
    const result = validateChangelog(
      makeInput({ claimedChangelog: CORRECT_V1_TO_V2_CHANGELOG }),
    );
    expect(result.verdict).toBe("promote-safe");
    expect(result.reasons).toHaveLength(0);
  });

  it("identical snapshots + empty claimed changelog → promote-safe", () => {
    const result = validateChangelog(
      makeInput({
        fromSnapshot: SNAPSHOT_V1,
        toSnapshot: SNAPSHOT_V1,
        claimedChangelog: [],
      }),
    );
    expect(result.verdict).toBe("promote-safe");
    expect(result.reasons).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VALIDATOR-2: Changelog omits a changed member → blocked
// ---------------------------------------------------------------------------
describe("VALIDATOR-2: omitted change in claimed changelog → blocked", () => {
  it("omitting object_schema from changelog when it changed → blocked", () => {
    // Claim everything except object_schema
    const incomplete: ClaimedChange[] = CORRECT_V1_TO_V2_CHANGELOG.filter(
      (c) => c.member !== "object_schema",
    );
    const result = validateChangelog(makeInput({ claimedChangelog: incomplete }));
    expect(result.verdict).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("object schema") && r.includes("omission"))).toBe(true);
  });

  it("omitting grants from changelog when grants changed → blocked", () => {
    const incomplete: ClaimedChange[] = CORRECT_V1_TO_V2_CHANGELOG.filter(
      (c) => c.member !== "grants",
    );
    const result = validateChangelog(makeInput({ claimedChangelog: incomplete }));
    expect(result.verdict).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("grants") && r.includes("omission"))).toBe(true);
  });

  it("completely empty changelog when two members changed → blocked with two omissions", () => {
    // V1→V2 has 4 changes; empty changelog omits all
    const result = validateChangelog(makeInput({ claimedChangelog: [] }));
    expect(result.verdict).toBe("blocked");
    // All 4 members changed should appear as omissions
    expect(result.reasons.filter((r) => r.includes("omission"))).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// VALIDATOR-3: Spurious claim (member did not change) → blocked
// ---------------------------------------------------------------------------
describe("VALIDATOR-3: spurious changelog entry → blocked", () => {
  it("claiming bpmn_process changed when it did not → blocked", () => {
    // bpmn_process is identical in V1 and V2
    const spurious: ClaimedChange[] = [
      ...CORRECT_V1_TO_V2_CHANGELOG,
      { member: "bpmn_process", kind: "updated" },
    ];
    const result = validateChangelog(makeInput({ claimedChangelog: spurious }));
    expect(result.verdict).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("BPMN") && r.includes("spurious"))).toBe(true);
  });

  it("claiming a change on an unchanged grants member → blocked", () => {
    // Use identical snapshots (nothing changed) but claim grants changed
    const spurious: ClaimedChange[] = [{ member: "grants", kind: "updated" }];
    const result = validateChangelog(
      makeInput({ fromSnapshot: SNAPSHOT_V1, toSnapshot: SNAPSHOT_V1, claimedChangelog: spurious }),
    );
    expect(result.verdict).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("spurious"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VALIDATOR-4: Kind mismatch → blocked
// ---------------------------------------------------------------------------
describe("VALIDATOR-4: kind mismatch in claimed changelog → blocked", () => {
  it("claiming 'added' for object_schema when it was actually 'updated' → blocked", () => {
    const wrong: ClaimedChange[] = CORRECT_V1_TO_V2_CHANGELOG.map((c) =>
      c.member === "object_schema" ? { ...c, kind: "added" as const } : c,
    );
    const result = validateChangelog(makeInput({ claimedChangelog: wrong }));
    expect(result.verdict).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("kind mismatch") && r.includes("object schema"))).toBe(true);
  });

  it("claiming 'removed' for form_code when it was actually 'added' → blocked", () => {
    const wrong: ClaimedChange[] = CORRECT_V1_TO_V2_CHANGELOG.map((c) =>
      c.member === "form_code" ? { ...c, kind: "removed" as const } : c,
    );
    const result = validateChangelog(makeInput({ claimedChangelog: wrong }));
    expect(result.verdict).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("kind mismatch") && r.includes("form code"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VALIDATOR-5: Duplicate member in claimed changelog → blocked
// ---------------------------------------------------------------------------
describe("VALIDATOR-5: duplicate member in claimed changelog → blocked", () => {
  it("two entries for the same member in the claimed changelog → blocked", () => {
    const dup: ClaimedChange[] = [
      ...CORRECT_V1_TO_V2_CHANGELOG,
      { member: "object_schema", kind: "updated" }, // duplicate
    ];
    const result = validateChangelog(makeInput({ claimedChangelog: dup }));
    expect(result.verdict).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("duplicate") && r.includes("object_schema"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VALIDATOR-6: Lossy schema change → blocked
// ---------------------------------------------------------------------------
describe("VALIDATOR-6: lossy schema change with active aggregate dep → blocked", () => {
  it("dropping a field that an aggregate dep uses → blocked", () => {
    const snapshotWithField: BundleSnapshot = {
      ...EMPTY_SNAPSHOT,
      object_schema: JSON.stringify({
        type: "object",
        properties: {
          amount: { type: "number" },
          note: { type: "string" },
        },
      }),
    };
    const snapshotDroppedField: BundleSnapshot = {
      ...EMPTY_SNAPSHOT,
      object_schema: JSON.stringify({
        type: "object",
        properties: {
          // 'amount' dropped
          note: { type: "string" },
        },
      }),
    };

    const aggregateDep: AffectedDep = {
      page_id: "page-uuid-001",
      page_slug: "cost-summary",
      registry_def_id: "reg-uuid-001",
      field_key: "amount",
      dep_kind: "aggregate",
    };

    const result = validateChangelog({
      fromSnapshot: snapshotWithField,
      toSnapshot: snapshotDroppedField,
      claimedChangelog: [{ member: "object_schema", kind: "updated" }],
      activeDeps: [aggregateDep],
    });

    expect(result.verdict).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("schema-destructive") && r.includes("amount"))).toBe(true);
  });

  it("narrowing number to integer with aggregate dep → blocked", () => {
    const oldSchema: BundleSnapshot = {
      ...EMPTY_SNAPSHOT,
      object_schema: JSON.stringify({
        type: "object",
        properties: { qty: { type: "number" } },
      }),
    };
    const newSchema: BundleSnapshot = {
      ...EMPTY_SNAPSHOT,
      object_schema: JSON.stringify({
        type: "object",
        properties: { qty: { type: "integer" } },
      }),
    };

    const aggregateDep: AffectedDep = {
      page_id: "page-uuid-002",
      page_slug: "qty-report",
      registry_def_id: "reg-uuid-002",
      field_key: "qty",
      dep_kind: "aggregate",
    };

    const result = validateChangelog({
      fromSnapshot: oldSchema,
      toSnapshot: newSchema,
      claimedChangelog: [{ member: "object_schema", kind: "updated" }],
      activeDeps: [aggregateDep],
    });

    expect(result.verdict).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("schema-destructive") && r.includes("qty"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VALIDATOR-7: Additive schema change → promote-safe
// ---------------------------------------------------------------------------
describe("VALIDATOR-7: additive schema change → promote-safe", () => {
  it("adding a new field to object_schema → promote-safe (no active deps affected)", () => {
    const oldSnap: BundleSnapshot = {
      ...EMPTY_SNAPSHOT,
      object_schema: JSON.stringify({ type: "object", properties: { name: { type: "string" } } }),
    };
    const newSnap: BundleSnapshot = {
      ...EMPTY_SNAPSHOT,
      object_schema: JSON.stringify({
        type: "object",
        properties: { name: { type: "string" }, email: { type: "string" } },
      }),
    };

    const result = validateChangelog({
      fromSnapshot: oldSnap,
      toSnapshot: newSnap,
      claimedChangelog: [{ member: "object_schema", kind: "updated" }],
      activeDeps: [],
    });

    expect(result.verdict).toBe("promote-safe");
    expect(result.reasons).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VALIDATOR-8: Soft schema narrowing (read dep) → promote-safe with warning
// ---------------------------------------------------------------------------
describe("VALIDATOR-8: soft schema narrowing for read dep → promote-safe with warning", () => {
  it("number→integer on a read dep → promote-safe but with a warning", () => {
    const oldSnap: BundleSnapshot = {
      ...EMPTY_SNAPSHOT,
      object_schema: JSON.stringify({ type: "object", properties: { qty: { type: "number" } } }),
    };
    const newSnap: BundleSnapshot = {
      ...EMPTY_SNAPSHOT,
      object_schema: JSON.stringify({ type: "object", properties: { qty: { type: "integer" } } }),
    };

    const readDep: AffectedDep = {
      page_id: "page-uuid-003",
      page_slug: "qty-display",
      registry_def_id: "reg-uuid-003",
      field_key: "qty",
      dep_kind: "read",
    };

    const result = validateChangelog({
      fromSnapshot: oldSnap,
      toSnapshot: newSnap,
      claimedChangelog: [{ member: "object_schema", kind: "updated" }],
      activeDeps: [readDep],
    });

    expect(result.verdict).toBe("promote-safe");
    expect(result.reasons).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("schema-soft-warning") && w.includes("qty"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VALIDATOR-9: Malformed form_json_schema → blocked
// ---------------------------------------------------------------------------
describe("VALIDATOR-9: malformed form_json_schema → blocked", () => {
  it("invalid JSON in form_json_schema → blocked", () => {
    const badSnap: BundleSnapshot = {
      ...SNAPSHOT_V1,
      form_json_schema: "{ not valid json !!!",
    };
    const result = validateChangelog({
      fromSnapshot: SNAPSHOT_V1,
      toSnapshot: badSnap,
      claimedChangelog: [{ member: "form_json_schema", kind: "added" }],
      activeDeps: [],
    });
    expect(result.verdict).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("form-schema-invalid"))).toBe(true);
  });

  it("form_json_schema is a JSON array (not object) → blocked", () => {
    const badSnap: BundleSnapshot = {
      ...SNAPSHOT_V1,
      form_json_schema: '["not","an","object"]',
    };
    const result = validateChangelog({
      fromSnapshot: SNAPSHOT_V1,
      toSnapshot: badSnap,
      claimedChangelog: [{ member: "form_json_schema", kind: "added" }],
      activeDeps: [],
    });
    expect(result.verdict).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("form-schema-invalid"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VALIDATOR-10: No changes, empty changelog → promote-safe
// ---------------------------------------------------------------------------
describe("VALIDATOR-10: no changes + empty changelog → promote-safe", () => {
  it("identical snapshots with no claimed changes → promote-safe", () => {
    const result = validateChangelog({
      fromSnapshot: SNAPSHOT_V1,
      toSnapshot: SNAPSHOT_V1,
      claimedChangelog: [],
      activeDeps: [],
    });
    expect(result.verdict).toBe("promote-safe");
    expect(result.reasons).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VALIDATOR-11: Genesis (from empty snapshot) → all added, correctly claimed
// ---------------------------------------------------------------------------
describe("VALIDATOR-11: genesis-like (from empty to populated)", () => {
  it("first commit (from empty) — all non-empty members are 'added', correctly claimed", () => {
    const toSnap: BundleSnapshot = {
      object_schema: '{"type":"object"}',
      grants: '[{"resource_type":"record","action":"read"}]',
      bpmn_process: "<process/>",
      form_code: "",
      form_json_schema: "",
    };

    const claimed: ClaimedChange[] = [
      { member: "object_schema", kind: "added" },
      { member: "grants", kind: "added" },
      { member: "bpmn_process", kind: "added" },
    ];

    const result = validateChangelog({
      fromSnapshot: EMPTY_SNAPSHOT,
      toSnapshot: toSnap,
      claimedChangelog: claimed,
      activeDeps: [],
    });

    expect(result.verdict).toBe("promote-safe");
    expect(result.reasons).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VALIDATOR-12: diffBundleSnapshots is independent of deriveSemanticChangelog
// ---------------------------------------------------------------------------
describe("VALIDATOR-12: diffBundleSnapshots independent computation", () => {
  it("diffBundleSnapshots returns correct member changes without calling deriveSemanticChangelog", () => {
    const diff = diffBundleSnapshots(SNAPSHOT_V1, SNAPSHOT_V2);

    // Should find: object_schema updated, grants updated, form_code added, form_json_schema added
    expect(diff).toHaveLength(4);

    const memberKindMap = new Map(diff.map((d) => [d.member, d.kind]));
    expect(memberKindMap.get("object_schema")).toBe("updated");
    expect(memberKindMap.get("grants")).toBe("updated");
    expect(memberKindMap.get("form_code")).toBe("added");
    expect(memberKindMap.get("form_json_schema")).toBe("added");
    // bpmn_process did NOT change
    expect(memberKindMap.has("bpmn_process")).toBe(false);
  });

  it("diffBundleSnapshots detects removed member", () => {
    const oldSnap: BundleSnapshot = { ...EMPTY_SNAPSHOT, bpmn_process: "<process/>" };
    const newSnap: BundleSnapshot = { ...EMPTY_SNAPSHOT, bpmn_process: "" };
    const diff = diffBundleSnapshots(oldSnap, newSnap);
    expect(diff).toHaveLength(1);
    expect(diff[0].member).toBe("bpmn_process");
    expect(diff[0].kind).toBe("removed");
  });

  it("diffBundleSnapshots returns empty array for identical snapshots", () => {
    const diff = diffBundleSnapshots(SNAPSHOT_V1, SNAPSHOT_V1);
    expect(diff).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VALIDATOR-13: form_json_schema is a JSON array → blocked
// ---------------------------------------------------------------------------
describe("VALIDATOR-13: form_json_schema must be a JSON object", () => {
  it("a JSON number as form_json_schema → blocked", () => {
    const snap: BundleSnapshot = {
      ...EMPTY_SNAPSHOT,
      form_json_schema: "42",
    };
    const result = validateChangelog({
      fromSnapshot: EMPTY_SNAPSHOT,
      toSnapshot: snap,
      claimedChangelog: [{ member: "form_json_schema", kind: "added" }],
      activeDeps: [],
    });
    expect(result.verdict).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("form-schema-invalid"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VALIDATOR-14: form_json_schema empty string → safe (deferred member)
// ---------------------------------------------------------------------------
describe("VALIDATOR-14: empty form_json_schema → safe (deferred, not validated)", () => {
  it("empty form_json_schema is valid (deferred member)", () => {
    const result = validateChangelog({
      fromSnapshot: EMPTY_SNAPSHOT,
      toSnapshot: EMPTY_SNAPSHOT,
      claimedChangelog: [],
      activeDeps: [],
    });
    expect(result.verdict).toBe("promote-safe");
  });
});

// ---------------------------------------------------------------------------
// VALIDATOR-15: unparseable object_schema → blocked
// ---------------------------------------------------------------------------
describe("VALIDATOR-15: unparseable object_schema → blocked", () => {
  it("malformed object_schema JSON in toSnapshot → blocked with schema-parse-error", () => {
    const badSnap: BundleSnapshot = {
      ...EMPTY_SNAPSHOT,
      object_schema: "{ not: json }",
    };
    const result = validateChangelog({
      fromSnapshot: EMPTY_SNAPSHOT,
      toSnapshot: badSnap,
      claimedChangelog: [{ member: "object_schema", kind: "added" }],
      activeDeps: [],
    });
    expect(result.verdict).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("schema-parse-error"))).toBe(true);
  });
});
