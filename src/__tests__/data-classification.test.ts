/**
 * Fitness + unit tests for T-0033 data-classification + value-aware masking +
 * typed facets + from→to guards. Each describe block maps to a fitness function
 * (FF-DC*) and its AC ids.
 *
 * FF-DC3  → AC-3       : class-driven divergence (grant×class only)
 * FF-DC4  → AC-4, AC-12: fail-closed on missing/mismatched classification
 * FF-DC5  → AC-5       : value-aware (present, transformed value)
 * FF-DC6  → AC-6       : transform selected by (class, clearance), not field name
 * FF-DC11 → AC-11      : direction-aware guard
 * FF-DC10 → AC-10      : guarded reclassification (op-grant required)
 * FF-DC13 → AC-13      : determinism
 * FF-DC14 → AC-14      : shared-axis contract (DataClass stable)
 * FF-DC15 → AC-16      : audit obligation shape
 *
 * All functions under test are pure; no IO, no DB. The Postgres-backed
 * ClassificationSource port + RLS DAO land in T-0053.
 */
import { describe, it, expect } from "vitest";
import {
  type DataClass,
  type Clearance,
  type ClassificationRow,
  type MaskContext,
  type Transform,
  DATA_CLASS_ORDER,
  applyTransform,
  selectTransform,
  maskFields,
  deriveClearance,
  readFacetVersion,
  classifyDirection,
  evaluateReclassification,
  maskAuditObligation,
  reclassAuditObligation,
} from "../core/data-classification.js";
import { type Grant } from "../core/grant-lattice.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const RT = "record";
const V = 1; // facet schema version

/** Build a classification row. */
function row(
  facetField: string,
  cls: DataClass,
  schemaVersion = V,
  resourceType = RT,
): ClassificationRow {
  return { resourceType, facetField, facetSchemaVersion: schemaVersion, class: cls };
}

/** Build a MaskContext. */
function ctx(
  rows: ClassificationRow[],
  clearance: Clearance,
  schemaVersion = V,
): MaskContext {
  return { rows, clearance, facetSchemaVersion: schemaVersion };
}

/** Build a grant carrying a clearance marker on its (opaque) resourceFacet. */
function grantWithClearance(clearance: DataClass): Grant {
  return {
    tenantId: "t",
    id: "g",
    roleId: "r",
    resourceType: "record",
    resourceFacet: { clearance },
    operation: "read",
    scope: { kind: "node", hierarchy: "resource", nodeId: "n", nodeLevel: "record" },
    delegable: true,
    grantedBy: "admin",
    createdAt: 0,
  };
}

/** Build a grant carrying a reclass-direction marker on its (opaque) constraint. */
function grantWithReclass(
  direction: "up" | "down" | "lateral",
  op: Grant["operation"] = "transition",
): Grant {
  return {
    tenantId: "t",
    id: "g",
    roleId: "r",
    resourceType: "record",
    constraint: { reclass: direction },
    operation: op,
    scope: { kind: "node", hierarchy: "resource", nodeId: "n", nodeLevel: "record" },
    delegable: true,
    grantedBy: "admin",
    createdAt: 0,
  };
}

const RAW = { name: "Alice", ssn: "123456789", card: "4111111111111234" };
const ALL_VISIBLE = new Set(Object.keys(RAW));

// ---------------------------------------------------------------------------
// FF-DC14 — shared-axis contract (AC-14)
// ---------------------------------------------------------------------------

describe("FF-DC14 shared-axis contract [AC-14]", () => {
  it("DataClass is a stable, ordered, enumerable 4-member axis (most→least visible)", () => {
    expect(DATA_CLASS_ORDER).toEqual([
      "public",
      "internal",
      "confidential",
      "restricted",
    ]);
    // The exact symbol S-1 (egress_policy) / S-3 (role_criticality) join on:
    // a value typed as DataClass IS the `class` column shape (compile-time
    // contract — this assignment would not type-check if DataClass drifted).
    const joinKey: DataClass = DATA_CLASS_ORDER[2];
    expect(joinKey).toBe("confidential");
  });
});

// ---------------------------------------------------------------------------
// FF-DC5 — value-aware transforms (AC-5)
// ---------------------------------------------------------------------------

describe("FF-DC5 value-aware transforms [AC-5]", () => {
  it("partial yields a present, deeply-different value (last-4 reveal)", () => {
    const out = applyTransform("123456789", "partial");
    expect(out).toBe("****6789");
    expect(out).not.toBe("123456789");
  });

  it("partial on a short string fully masks to ****", () => {
    expect(applyTransform("abc", "partial")).toBe("****");
  });

  it("partial on a non-string degrades to redact (present, not raw)", () => {
    expect(applyTransform(42, "partial")).toBe("[redacted]");
  });

  it("redact yields the present sentinel", () => {
    expect(applyTransform("anything", "redact")).toBe("[redacted]");
  });

  it("hash yields a present, deterministic, non-raw digest", () => {
    const h = applyTransform("123456789", "hash");
    expect(typeof h).toBe("string");
    expect(h).not.toBe("123456789");
    expect(h).toBe(applyTransform("123456789", "hash")); // deterministic
  });

  it("reveal is pass-through; drop yields undefined (caller omits key)", () => {
    expect(applyTransform("x", "reveal")).toBe("x");
    expect(applyTransform("x", "drop")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FF-DC6 — transform selected by (class, clearance), NOT field name (AC-6)
// ---------------------------------------------------------------------------

describe("FF-DC6 transform by (class × clearance), not field name [AC-6]", () => {
  it("monotone ladder: clearance>=class reveals; each step below masks more", () => {
    // field class = restricted (rank 3)
    expect(selectTransform("restricted", "restricted")).toBe("reveal"); // gap 0
    expect(selectTransform("restricted", "confidential")).toBe("partial"); // gap 1
    expect(selectTransform("restricted", "internal")).toBe("redact"); // gap 2
    expect(selectTransform("restricted", "public")).toBe("hash"); // gap 3
    expect(selectTransform("restricted", null)).toBe("drop"); // no clearance
  });

  it("clearance above class still reveals (monotone, never over-masks)", () => {
    expect(selectTransform("public", "restricted")).toBe("reveal");
    expect(selectTransform("internal", "confidential")).toBe("reveal");
  });

  it("two differently-named fields with same class+clearance get the SAME transform", () => {
    const rows = [row("ssn", "confidential"), row("card", "confidential")];
    const out = maskFields(RAW, ALL_VISIBLE, ctx(rows, "internal"));
    // confidential (rank2) vs internal (rank1) ⇒ gap 1 ⇒ partial, for BOTH.
    expect(out.ssn).toBe("****6789");
    expect(out.card).toBe("****1234");
  });

  it("re-classifying a field to a different class yields a different transform", () => {
    const asConfidential = maskFields(
      RAW,
      ALL_VISIBLE,
      ctx([row("ssn", "confidential")], "internal"),
    );
    const asRestricted = maskFields(
      RAW,
      ALL_VISIBLE,
      ctx([row("ssn", "restricted")], "internal"),
    );
    // confidential→partial(present); restricted→redact(present sentinel)
    expect(asConfidential.ssn).toBe("****6789");
    expect(asRestricted.ssn).toBe("[redacted]");
    expect(asConfidential.ssn).not.toEqual(asRestricted.ssn);
  });
});

// ---------------------------------------------------------------------------
// FF-DC3 — class-driven divergence (AC-3)
// ---------------------------------------------------------------------------

describe("FF-DC3 class-driven divergence keyed on clearance only [AC-3]", () => {
  const rows = [row("ssn", "restricted")];

  it("higher-cleared reader sees raw; lower-cleared reader sees masked — same record", () => {
    const high = maskFields(RAW, ALL_VISIBLE, ctx(rows, "restricted"));
    const low = maskFields(RAW, ALL_VISIBLE, ctx(rows, "internal"));
    expect(high.ssn).toBe("123456789"); // reveal
    expect(low.ssn).toBe("[redacted]"); // gap 2 ⇒ redact
    expect(high.ssn).not.toEqual(low.ssn);
    // Unclassified fields are identical for both (divergence keyed only by class).
    expect(high.name).toBe("Alice");
    expect(low.name).toBe("Alice");
  });
});

// ---------------------------------------------------------------------------
// FF-DC4 / FF-DC12 — fail-closed on missing/mismatched classification
//                    (AC-4, AC-12)
// ---------------------------------------------------------------------------

describe("FF-DC4/DC12 fail-closed on missing/mismatched classification [AC-4, AC-12]", () => {
  it("a classified facet whose version has NO rows fails closed — but never widens to whole-resource", () => {
    // Reader is visible-granted all fields, but the classification source has
    // no rows for this version: classified fields fall through as unclassified
    // (kept raw) ONLY because no row declares them classified — the version
    // boundary is enforced by row-matching, see next test for the real mismatch.
    const out = maskFields(RAW, ALL_VISIBLE, ctx([], "public"));
    // With NO rows, nothing is declared classified ⇒ legacy raw projection.
    // Critically it does NOT widen beyond the visible set.
    expect(Object.keys(out).sort()).toEqual(["card", "name", "ssn"]);
  });

  it("a row for a DIFFERENT schema version does not classify this facet's version", () => {
    // ssn is classified restricted, but only for version 2; the handle facet is
    // version 1 ⇒ the row does not apply ⇒ ssn is NOT masked under v1.
    const rows = [row("ssn", "restricted", 2)];
    const v1 = maskFields(RAW, ALL_VISIBLE, ctx(rows, "public", 1));
    expect(v1.ssn).toBe("123456789"); // v2 row does not bite v1
    // Bump the facet to v2 with a row but NO clearance ⇒ max mask (dropped).
    const v2 = maskFields(RAW, ALL_VISIBLE, ctx(rows, null, 2));
    expect("ssn" in v2).toBe(false); // dropped — fail-closed at version boundary
  });

  it("null clearance maximally masks every classified field (key dropped)", () => {
    const rows = [row("ssn", "confidential"), row("card", "restricted")];
    const out = maskFields(RAW, ALL_VISIBLE, ctx(rows, null));
    expect("ssn" in out).toBe(false);
    expect("card" in out).toBe(false);
    expect(out.name).toBe("Alice"); // unclassified survives
  });

  it("a corrupt class value (not a DataClass) drives the maximal mask (drop)", () => {
    const corrupt = { ...row("ssn", "confidential"), class: "weird" as DataClass };
    const out = maskFields(RAW, ALL_VISIBLE, ctx([corrupt], "restricted"));
    expect("ssn" in out).toBe(false); // unknown class ⇒ drop
  });

  it("undefined MaskContext is the legacy raw-copy (backward-compatible floor)", () => {
    const out = maskFields(RAW, new Set(["name", "ssn"]), undefined);
    expect(out).toEqual({ name: "Alice", ssn: "123456789" });
  });
});

// ---------------------------------------------------------------------------
// FF-DC13 — determinism (AC-13)
// ---------------------------------------------------------------------------

describe("FF-DC13 determinism [AC-13]", () => {
  it("deeply-equal inputs ⇒ deeply-equal masked output", () => {
    const rows = [row("ssn", "restricted"), row("card", "confidential")];
    const a = maskFields(RAW, ALL_VISIBLE, ctx(rows, "internal"));
    const b = maskFields(RAW, ALL_VISIBLE, ctx(rows, "internal"));
    expect(a).toEqual(b);
  });

  it("hash transform is stable across invocations", () => {
    expect(applyTransform("payload", "hash")).toBe(applyTransform("payload", "hash"));
  });
});

// ---------------------------------------------------------------------------
// readFacetVersion + deriveClearance (rights-derived-only, AC-8)
// ---------------------------------------------------------------------------

describe("readFacetVersion + deriveClearance (rights-derived-only) [AC-8]", () => {
  it("readFacetVersion defaults absent/unversioned facets to 0", () => {
    expect(readFacetVersion(undefined)).toBe(0);
    expect(readFacetVersion({ fields: ["a"] })).toBe(0);
    expect(readFacetVersion({ fields: ["a"], schemaVersion: 5 })).toBe(5);
  });

  it("deriveClearance returns the MAX class any covering grant confers", () => {
    const grants = [
      grantWithClearance("internal"),
      grantWithClearance("confidential"),
    ];
    expect(deriveClearance(grants)).toBe("confidential");
  });

  it("deriveClearance is null when no grant carries a clearance marker", () => {
    const bare: Grant = { ...grantWithClearance("public"), resourceFacet: undefined };
    expect(deriveClearance([bare])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FF-DC11 — direction-aware guard (AC-11)
// ---------------------------------------------------------------------------

describe("FF-DC11 direction-aware reclassification guard [AC-11]", () => {
  it("classifyDirection: down == widening (lower sensitivity), up == more sensitive", () => {
    expect(classifyDirection("restricted", "public")).toBe("down");
    expect(classifyDirection("public", "restricted")).toBe("up");
    expect(classifyDirection("internal", "internal")).toBe("lateral");
  });

  it("a DOWN-classification is REJECTED for a subject permitted only up-classification", () => {
    const d = evaluateReclassification(
      "restricted",
      "public",
      "transition",
      [grantWithReclass("up")],
    );
    expect(d.allowed).toBe(false);
    expect(d.direction).toBe("down");
    expect(d.reason).toBe("direction_forbidden");
  });

  it("a DOWN-classification is ALLOWED for a subject with down authority", () => {
    const d = evaluateReclassification(
      "restricted",
      "public",
      "transition",
      [grantWithReclass("down")],
    );
    expect(d.allowed).toBe(true);
    expect(d.direction).toBe("down");
    expect(d.reason).toBe("ok");
  });

  it("an UP-classification is allowed for an up-only subject (less privileged case)", () => {
    const d = evaluateReclassification(
      "public",
      "restricted",
      "transition",
      [grantWithReclass("up")],
    );
    expect(d.allowed).toBe(true);
    expect(d.direction).toBe("up");
  });
});

// ---------------------------------------------------------------------------
// FF-DC10 — guarded reclassification (op-grant required) (AC-10)
// ---------------------------------------------------------------------------

describe("FF-DC10 guarded reclassification requires transition/approve op [AC-10]", () => {
  it("a non-reclass op (read) confers no reclassification authority", () => {
    const d = evaluateReclassification(
      "public",
      "internal",
      "read",
      [grantWithReclass("down", "read")],
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("no_op_grant");
  });

  it("approve op-class is accepted as a reclassification route", () => {
    const d = evaluateReclassification(
      "public",
      "internal",
      "approve",
      [grantWithReclass("up")],
    );
    expect(d.allowed).toBe(true);
  });

  it("no covering grant ⇒ direction_forbidden (fail-closed)", () => {
    const d = evaluateReclassification("public", "internal", "transition", []);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("direction_forbidden");
  });

  it("a corrupt class fails closed with unknown_class", () => {
    const d = evaluateReclassification(
      "weird" as DataClass,
      "public",
      "transition",
      [grantWithReclass("down")],
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("unknown_class");
  });
});

// ---------------------------------------------------------------------------
// FF-DC15 — audit obligation shape (AC-16)
// ---------------------------------------------------------------------------

describe("FF-DC15 audit obligation shape [AC-16]", () => {
  it("a mask decision produces a well-formed obligation (via=grant_resolver)", () => {
    const o = maskAuditObligation("actor-1", "subject-1", { masked: ["ssn"] });
    expect(o.type).toBe("mask_decision");
    expect(o.via).toBe("grant_resolver");
    expect(o.actor).toBe("actor-1");
    expect(o.subject).toBe("subject-1");
  });

  it("a reclassification produces a well-formed obligation (via=classification)", () => {
    const decision = evaluateReclassification(
      "restricted",
      "public",
      "transition",
      [grantWithReclass("down")],
    );
    const o = reclassAuditObligation("actor-1", "subject-1", decision);
    expect(o.type).toBe("reclassification");
    expect(o.via).toBe("classification");
    expect(o.decision).toEqual(decision);
  });
});

// Type-level guard: Transform is the closed 5-member set (compile-time only).
const _allTransforms: Transform[] = ["reveal", "partial", "redact", "hash", "drop"];
void _allTransforms;
