/**
 * T-0238 · T-0134b — Unit tests for checkDocRefs (no I/O, no DB).
 *
 * Mirrors template-compat.test.ts / report-page-compat discipline (T-0121).
 * Pure function under test — all assertions are synchronous.
 *
 * FF-LINT-BEHAVIOR: checkDocRefs is the zero-I/O check for «doc_ref ↔ live system» coherence.
 * FF-LINT-PURE verified by: doc-ref-lint-isolation.sh (no forbidden imports).
 *
 * Coverage:
 *   - All 5 ref_kinds: all-present → ok (FF-LINT-BEHAVIOR 'all-present')
 *   - One missing per kind → violation { type: 'missing_referent' } (FF-LINT-BEHAVIOR 'missing-referent')
 *   - Empty refs → ok
 *   - Multiple violations in one call
 */

import { describe, it, expect } from "vitest";
import {
  checkDocRefs,
  type DocRef,
  type LiveSnapshot,
  type DocRefKind,
} from "../doc-ref-lint.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ref(refKind: DocRefKind, refTarget: Record<string, string>): DocRef {
  return { refKind, refTarget };
}

function fullSnapshot(): LiveSnapshot {
  return {
    codeSymbols: new Set([
      "src/core/grant-lattice#BOTTOM",
      "src/core/audit-preimage#rowHash",
    ]),
    restEndpoints: new Set([
      "GET /api/org",
      "POST /api/grants",
      "DELETE /api/users/:id",
    ]),
    schemaFields: new Set([
      "reg-001#contractNo",
      "reg-001#status",
      "reg-002#amount",
    ]),
    processKeys: new Set(["invoice-approval", "onboarding"]),
    configKeys: new Set(["kc.realm", "storage.bucket", "features.llm"]),
  };
}

function emptySnapshot(): LiveSnapshot {
  return {
    codeSymbols: new Set(),
    restEndpoints: new Set(),
    schemaFields: new Set(),
    processKeys: new Set(),
    configKeys: new Set(),
  };
}

// ---------------------------------------------------------------------------
// Empty refs → ok (FF-LINT-BEHAVIOR 'all-present' edge case)
// ---------------------------------------------------------------------------

describe("checkDocRefs — empty refs", () => {
  it("returns ok:true when refs array is empty (full snapshot)", () => {
    const result = checkDocRefs([], fullSnapshot());
    expect(result.ok).toBe(true);
  });

  it("returns ok:true when refs array is empty (empty snapshot)", () => {
    const result = checkDocRefs([], emptySnapshot());
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// code_symbol
// ---------------------------------------------------------------------------

describe("checkDocRefs — code_symbol (FF-LINT-BEHAVIOR)", () => {
  it("returns ok:true when code_symbol referent is present in snapshot", () => {
    const refs: DocRef[] = [
      ref("code_symbol", { module: "src/core/grant-lattice", symbol: "BOTTOM" }),
    ];
    const result = checkDocRefs(refs, fullSnapshot());
    expect(result.ok).toBe(true);
  });

  it("returns violation when code_symbol is absent (FF-LINT-BEHAVIOR 'missing-referent')", () => {
    const refs: DocRef[] = [
      ref("code_symbol", { module: "src/core/unknown-module", symbol: "missingFn" }),
    ];
    const result = checkDocRefs(refs, fullSnapshot());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.type).toBe("missing_referent");
      expect(result.violations[0]!.refKind).toBe("code_symbol");
      expect(result.violations[0]!.refTarget).toEqual({
        module: "src/core/unknown-module",
        symbol: "missingFn",
      });
    }
  });

  it("returns ok:true for multiple code_symbol refs all present", () => {
    const refs: DocRef[] = [
      ref("code_symbol", { module: "src/core/grant-lattice", symbol: "BOTTOM" }),
      ref("code_symbol", { module: "src/core/audit-preimage", symbol: "rowHash" }),
    ];
    const result = checkDocRefs(refs, fullSnapshot());
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rest_endpoint
// ---------------------------------------------------------------------------

describe("checkDocRefs — rest_endpoint (FF-LINT-BEHAVIOR)", () => {
  it("returns ok:true when rest_endpoint referent is present", () => {
    const refs: DocRef[] = [
      ref("rest_endpoint", { method: "GET", path: "/api/org" }),
    ];
    const result = checkDocRefs(refs, fullSnapshot());
    expect(result.ok).toBe(true);
  });

  it("returns violation when rest_endpoint is absent", () => {
    const refs: DocRef[] = [
      ref("rest_endpoint", { method: "PUT", path: "/api/nonexistent" }),
    ];
    const result = checkDocRefs(refs, fullSnapshot());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.type).toBe("missing_referent");
      expect(result.violations[0]!.refKind).toBe("rest_endpoint");
    }
  });

  it("distinguishes method+path (GET /api/org present, DELETE /api/org absent)", () => {
    const refs: DocRef[] = [
      ref("rest_endpoint", { method: "DELETE", path: "/api/org" }),
    ];
    const result = checkDocRefs(refs, fullSnapshot());
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// schema_field
// ---------------------------------------------------------------------------

describe("checkDocRefs — schema_field (FF-LINT-BEHAVIOR)", () => {
  it("returns ok:true when schema_field referent is present", () => {
    const refs: DocRef[] = [
      ref("schema_field", { registryDefId: "reg-001", fieldKey: "contractNo" }),
    ];
    const result = checkDocRefs(refs, fullSnapshot());
    expect(result.ok).toBe(true);
  });

  it("returns violation when schema_field is absent", () => {
    const refs: DocRef[] = [
      ref("schema_field", { registryDefId: "reg-001", fieldKey: "deletedField" }),
    ];
    const result = checkDocRefs(refs, fullSnapshot());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.refKind).toBe("schema_field");
      expect(result.violations[0]!.refTarget).toEqual({
        registryDefId: "reg-001",
        fieldKey: "deletedField",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// process
// ---------------------------------------------------------------------------

describe("checkDocRefs — process (FF-LINT-BEHAVIOR)", () => {
  it("returns ok:true when processKey is present in snapshot", () => {
    const refs: DocRef[] = [
      ref("process", { processKey: "invoice-approval" }),
    ];
    const result = checkDocRefs(refs, fullSnapshot());
    expect(result.ok).toBe(true);
  });

  it("returns violation when processKey is absent", () => {
    const refs: DocRef[] = [
      ref("process", { processKey: "retired-process" }),
    ];
    const result = checkDocRefs(refs, fullSnapshot());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]!.refKind).toBe("process");
    }
  });
});

// ---------------------------------------------------------------------------
// config_key
// ---------------------------------------------------------------------------

describe("checkDocRefs — config_key (FF-LINT-BEHAVIOR)", () => {
  it("returns ok:true when config key is present in snapshot", () => {
    const refs: DocRef[] = [
      ref("config_key", { key: "kc.realm" }),
    ];
    const result = checkDocRefs(refs, fullSnapshot());
    expect(result.ok).toBe(true);
  });

  it("returns violation when config key is absent", () => {
    const refs: DocRef[] = [
      ref("config_key", { key: "deprecated.setting" }),
    ];
    const result = checkDocRefs(refs, fullSnapshot());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]!.refKind).toBe("config_key");
    }
  });
});

// ---------------------------------------------------------------------------
// Mixed: all 5 kinds present → ok (FF-LINT-BEHAVIOR 'all-present')
// ---------------------------------------------------------------------------

describe("checkDocRefs — all 5 kinds present → ok (FF-LINT-BEHAVIOR 'all-present')", () => {
  it("returns ok:true when all refs across all 5 kinds are in snapshot", () => {
    const refs: DocRef[] = [
      ref("code_symbol", { module: "src/core/grant-lattice", symbol: "BOTTOM" }),
      ref("rest_endpoint", { method: "POST", path: "/api/grants" }),
      ref("schema_field", { registryDefId: "reg-002", fieldKey: "amount" }),
      ref("process", { processKey: "onboarding" }),
      ref("config_key", { key: "storage.bucket" }),
    ];
    const result = checkDocRefs(refs, fullSnapshot());
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multiple violations in one call
// ---------------------------------------------------------------------------

describe("checkDocRefs — multiple violations", () => {
  it("collects all violations when multiple refs are broken", () => {
    const refs: DocRef[] = [
      ref("code_symbol", { module: "gone", symbol: "fn" }),
      ref("rest_endpoint", { method: "PATCH", path: "/api/nope" }),
      ref("config_key", { key: "missing.key" }),
      ref("process", { processKey: "onboarding" }), // present → no violation
    ];
    const result = checkDocRefs(refs, fullSnapshot());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(3);
      const kinds = result.violations.map((v) => v.refKind);
      expect(kinds).toContain("code_symbol");
      expect(kinds).toContain("rest_endpoint");
      expect(kinds).toContain("config_key");
    }
  });

  it("all refs missing (empty snapshot) → all are violations", () => {
    const refs: DocRef[] = [
      ref("code_symbol", { module: "m", symbol: "s" }),
      ref("rest_endpoint", { method: "GET", path: "/x" }),
    ];
    const result = checkDocRefs(refs, emptySnapshot());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(2);
    }
  });
});

// ---------------------------------------------------------------------------
// Violation shape: type must be 'missing_referent' (ADR §3.2)
// ---------------------------------------------------------------------------

describe("checkDocRefs — violation shape", () => {
  it("violation type is exactly 'missing_referent'", () => {
    const refs: DocRef[] = [
      ref("config_key", { key: "absent.key" }),
    ];
    const result = checkDocRefs(refs, fullSnapshot());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]!.type).toBe("missing_referent");
    }
  });

  it("violation carries refKind and refTarget from original ref", () => {
    const target = { registryDefId: "reg-X", fieldKey: "noField" };
    const refs: DocRef[] = [ref("schema_field", target)];
    const result = checkDocRefs(refs, fullSnapshot());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]!.refKind).toBe("schema_field");
      expect(result.violations[0]!.refTarget).toEqual(target);
    }
  });
});
