/**
 * Fitness + unit tests for T-0033 data-classification + value-aware masking +
 * typed facets + from→to guards. Each describe block maps to a fitness function
 * (FF-DC*) and its AC ids.
 *
 * FF-DC3  → AC-3       : class-driven divergence (grant×class only)
 * FF-DC4  → AC-4, AC-12: fail-closed on missing classification — 4a state U
 *                        (ungoverned ⇒ raw), 4b state G (governed, empty version
 *                        rows, non-null clearance ⇒ max mask)
 * FF-DC12 → AC-4, AC-12: version-boundary isolation (governed@vN, facet vM≠N,
 *                        MAXIMAL clearance ⇒ classified field dropped, raw absent)
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

/**
 * Build a MaskContext. rev-2 (R-1): `governed` defaults to `true` (a resource
 * with classification rows is governed). Existing FF-DC3/5/6/13 tests pass
 * non-empty rows for the fields under test, so they never reach the
 * `cls === undefined` fork and are unaffected by the default. The fail-closed
 * version-boundary tests (FF-DC4a/4b/DC12) set `governed` explicitly.
 */
function ctx(
  rows: ClassificationRow[],
  clearance: Clearance,
  schemaVersion = V,
  governed = true,
): MaskContext {
  return { governed, rows, clearance, facetSchemaVersion: schemaVersion };
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
    // The divergence is keyed ONLY by class: `name` (no row) is treated
    // IDENTICALLY for both readers. The resource is governed (ssn is
    // classified), so under rev-2 (R-1, truth-table row 4) `name` fails closed
    // for both — same outcome regardless of clearance (divergence is class-only,
    // not field-name driven).
    expect("name" in high).toBe(false);
    expect("name" in low).toBe(false);
    expect("name" in high).toBe("name" in low);
  });
});

// ---------------------------------------------------------------------------
// FF-DC4 / FF-DC12 — fail-closed on missing/mismatched classification
//                    (AC-4, AC-12)
// ---------------------------------------------------------------------------

describe("FF-DC4/DC12 fail-closed on missing/mismatched classification [AC-4, AC-12]", () => {
  // FF-DC4a (state U, ungoverned) — the legacy back-compat anchor. An
  // affirmatively-ungoverned resource (governed:false, zero rows at any
  // version) keeps every visible field RAW. This is the pre-T-0033 floor:
  // classification is additive; an untouched resource is not newly denied.
  it("FF-DC4a state U (ungoverned, governed:false) keeps fields raw — legacy floor", () => {
    const out = maskFields(RAW, ALL_VISIBLE, ctx([], "public", V, false));
    expect(Object.keys(out).sort()).toEqual(["card", "name", "ssn"]);
    // Raw values survive unchanged (this is the ungoverned legacy answer).
    expect(out.ssn).toBe("123456789");
  });

  // FF-DC4b (state G, governed) — a governed resource whose REQUESTED version
  // has ZERO rows, with NON-null clearance, max-masks the whole facet: classified
  // keys fall away (drop), raw NEVER appears, and it does NOT widen to whole-
  // resource. Clearance is held non-null ('restricted', the max) so the ONLY
  // lever producing the drop is governance×version — not null clearance.
  it("FF-DC4b state G (governed, empty version rows, NON-null clearance) max-masks — raw absent", () => {
    const out = maskFields(RAW, ALL_VISIBLE, ctx([], "restricted", V, true));
    // Governed + version V has no rows ⇒ every classified field drops (truth-
    // table row 3). No raw leak; no widening beyond the visible set.
    expect("ssn" in out).toBe(false);
    expect("card" in out).toBe(false);
    expect("name" in out).toBe(false);
    // Belt-and-suspenders: the raw value is nowhere in the output.
    expect(Object.values(out)).not.toContain("123456789");
  });

  // FF-DC12 (rev-2, R-1, the isolating test) — the version mechanism in
  // isolation. The resource IS governed (rows exist for version 2); the handle
  // facet is version 1; clearance is NON-null and MAXIMAL ('restricted'). The
  // classified field (ssn) MUST be absent under version 1 and its raw value MUST
  // NOT leak — reachable ONLY through the version boundary (truth-table row 3),
  // never through null clearance. With rev-1 code this is RED (returns raw);
  // with §10.3 it is GREEN. Negative probe on the VERSION axis.
  it("FF-DC12 governed@v2, facet v1, MAXIMAL clearance ⇒ ssn absent, value not leaked", () => {
    const rows = [row("ssn", "restricted", 2)]; // governed under version 2
    const out = maskFields(RAW, ALL_VISIBLE, ctx(rows, "restricted", 1, true));
    expect("ssn" in out).toBe(false); // dropped at the version boundary
    expect(Object.values(out)).not.toContain("123456789"); // raw never leaks
  });

  it("null clearance maximally masks every classified field (key dropped)", () => {
    const rows = [row("ssn", "confidential"), row("card", "restricted")];
    // Resource is GOVERNED (default) — classified ssn/card drop on null
    // clearance; `name` has no row for this version ⇒ truth-table row 4
    // (governed, version has rows but not for `name`) ⇒ also drops (fail-closed),
    // never raw. This is the rev-2 (R-1) inversion of the rev-1 raw fall-through.
    const out = maskFields(RAW, ALL_VISIBLE, ctx(rows, null));
    expect("ssn" in out).toBe(false);
    expect("card" in out).toBe(false);
    expect("name" in out).toBe(false); // governed ⇒ no-row field fails closed
  });

  it("null clearance on an UNGOVERNED resource keeps unclassified fields raw (state U)", () => {
    // governed:false ⇒ no row anywhere ⇒ legacy floor: every field is raw,
    // regardless of clearance (there is nothing classified to mask).
    const out = maskFields(RAW, ALL_VISIBLE, ctx([], null, V, false));
    expect(out.name).toBe("Alice");
    expect(out.ssn).toBe("123456789");
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
