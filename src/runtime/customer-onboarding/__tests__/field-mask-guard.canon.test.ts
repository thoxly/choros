/**
 * src/runtime/customer-onboarding/__tests__/field-mask-guard.canon.test.ts — T-0255
 *
 * Closes a field-mask write-guard BYPASS: pre-T-0255, checkWriteMask decided
 * membership with an exact-match Set.has on raw wire field names, so a casing /
 * whitespace / kebab-alias variant of a system-only field (e.g. `CIRCUIT_ID`,
 * ` circuit_id `, `circuit-id`) slipped past the mask. The predicate is now
 * hardened: it canonicalises BOTH the grant's writeFacet allow-list AND each
 * requested field before the membership test.
 *
 * This is a UNIT test of the LIVE predicate (checkWriteMask + canonicaliseFieldName).
 * It lives outside ci/checks/db/ (normal `vitest run` flow) — the field-mask proof
 * needs no Postgres, and ci/checks/db/*.test.ts is frozen by FF-T147-2 (db-isolation).
 *
 * Anti-over-block: legitimate distinct fields (circuit, circuit_id_history, …) and
 * cased/aliased forms of ALLOWED facet fields must STILL pass — the fix must not
 * over-restrict valid writes.
 */

import { describe, it, expect } from "vitest";

import {
  checkWriteMask,
  canonicaliseFieldName,
} from "../field-mask-guard.js";

// A restricted vendor-admin facet that does NOT include any system-only field.
const VENDOR_FACET = ["plan", "notes", "not_after"];

describe("T-0255: checkWriteMask canonicalisation — bypass variants are blocked", () => {
  // Every variant below RESOLVES to a system-only field and MUST be denied even
  // though none is byte-identical to the canonical column name.
  const BYPASS_VARIANTS: Array<[string, string]> = [
    ["CIRCUIT_ID", "uppercase"],
    ["Circuit_Id", "mixed case"],
    ["  circuit_id  ", "surrounding whitespace"],
    ["circuit_id\t", "trailing tab"],
    ["circuit-id", "kebab alias"],
    ["circuit id", "inner whitespace alias"],
    [" CIRCUIT-ID ", "case + kebab + whitespace"],
    ["ACTIVATION_KEY_ISSUED_AT", "uppercase (second system field)"],
    ["activation-key-issued-at", "kebab alias (second system field)"],
    [" activation_key_issued_at ", "whitespace pad (second system field)"],
  ];

  for (const [variant, label] of BYPASS_VARIANTS) {
    it(`blocks ${label}: ${JSON.stringify(variant)} → denied=true`, () => {
      const result = checkWriteMask(VENDOR_FACET, [variant]);
      expect(result.denied).toBe(true);
      if (result.denied) {
        expect(result.reason).toBe("system_field_write_blocked");
        // The audit trail records the ORIGINAL wire name the caller actually sent.
        expect(result.blockedFields).toContain(variant);
      }
    });
  }

  it("blocks a bypass variant mixed in with legitimate fields", () => {
    const result = checkWriteMask(VENDOR_FACET, ["plan", "CIRCUIT_ID", "notes"]);
    expect(result.denied).toBe(true);
    if (result.denied) {
      expect(result.blockedFields).toEqual(["CIRCUIT_ID"]);
    }
  });

  it("blocks duplicate bypass variants (dedup-blind allow-lists)", () => {
    const result = checkWriteMask(VENDOR_FACET, ["circuit-id", "circuit-id"]);
    expect(result.denied).toBe(true);
    if (result.denied) {
      expect(result.blockedFields).toEqual(["circuit-id", "circuit-id"]);
    }
  });
});

describe("T-0255: checkWriteMask canonicalisation — no over-blocking of valid writes", () => {
  it("does NOT over-block legitimate fields that merely look similar", () => {
    // `circuit_id_history`, `circuit`, `circuited` are DISTINCT columns — not the
    // system-only `circuit_id` — so they must not be swept up by canonicalisation.
    const result = checkWriteMask(VENDOR_FACET, [
      "plan",
      "notes",
      "circuit", // distinct field
      "circuit_id_history", // distinct field
      "circuited", // distinct field
    ]);
    expect(result.denied).toBe(false);
  });

  it("does NOT over-block cased/aliased forms of an ALLOWED facet field", () => {
    // `NOT_AFTER`, ` plan `, `not-after` all canonicalise to facet members, so the
    // facet allow-list (also canonicalised) must keep matching them → allowed.
    const facet = ["plan", "not_after", "notes"];
    const result = checkWriteMask(facet, ["NOT_AFTER", " plan ", "not-after"]);
    expect(result.denied).toBe(false);
  });

  it("allows a system-only field when the grant facet EXPLICITLY grants it (cased)", () => {
    // If a facet legitimately carries circuit_id (any casing/alias), it is allowed
    // — canonicalising the facet keeps the explicit grant effective.
    const facet = ["plan", "CIRCUIT_ID"]; // facet itself carries circuit_id (cased)
    const result = checkWriteMask(facet, ["circuit_id"]);
    expect(result.denied).toBe(false);
  });

  it("whole-resource write (writeFacet undefined) is never denied (system-actor path)", () => {
    const result = checkWriteMask(undefined, ["CIRCUIT_ID", " activation_key_issued_at "]);
    expect(result.denied).toBe(false);
  });
});

describe("T-0255: canonicaliseFieldName — pure normaliser", () => {
  it("folds case, trims, and collapses whitespace/kebab to snake", () => {
    expect(canonicaliseFieldName("CIRCUIT_ID")).toBe("circuit_id");
    expect(canonicaliseFieldName("  circuit_id  ")).toBe("circuit_id");
    expect(canonicaliseFieldName("circuit_id\t")).toBe("circuit_id");
    expect(canonicaliseFieldName("circuit-id")).toBe("circuit_id");
    expect(canonicaliseFieldName("circuit id")).toBe("circuit_id");
    expect(canonicaliseFieldName(" CIRCUIT-ID ")).toBe("circuit_id");
  });

  it("is referentially transparent (same input ⇒ same output, no IO)", () => {
    const a = canonicaliseFieldName(" Activation-Key-Issued-At ");
    const b = canonicaliseFieldName(" Activation-Key-Issued-At ");
    expect(a).toBe(b);
    expect(a).toBe("activation_key_issued_at");
  });

  it("leaves a distinct field distinct (no false collision)", () => {
    expect(canonicaliseFieldName("circuit_id_history")).toBe("circuit_id_history");
    expect(canonicaliseFieldName("circuit")).toBe("circuit");
  });
});
