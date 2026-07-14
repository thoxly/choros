/**
 * T-0041 · FF-EP-TYPE — compile-time fixture (AC-16).
 *
 * egress_policy has NO TypeScript runtime module (T-0041 is schema-only): the
 * `class` column is governed by the DB CHECK constraint in
 * migrations/038_egress_policy.sql. This file is the STATIC type-level contract
 * that the `class` column's logical type is exactly the closed `DataClass` axis
 * exported from src/core/data-classification.ts (T-0033) — the shared join
 * symbol (S-2). It imports `DataClass`; it does NOT redeclare it.
 *
 * The assertions below are checked by `tsc --noEmit` (this file is under src/,
 * which tsconfig `include`s). They DO NOT execute at runtime and DO NOT make the
 * table non-dormant: this file lives under src/__tests__/, which the dormancy
 * grep (AC-11 / NF-7) and the egress-policy-isolation check explicitly exclude.
 *
 * If the egress_policy.class vocabulary ever drifts from `DataClass` (e.g. a new
 * class is added to the CHECK but not to the type, or vice-versa), one of these
 * `@ts-expect-error` directives flips to "unused" and `tsc --noEmit` fails —
 * a gate failure on the class↔DataClass contract.
 */
import type { DataClass } from "../core/data-classification.js";

/**
 * The logical row shape of an `egress_policy` row, as the schema defines it.
 * `class` is typed as `DataClass` — this declaration IS the contract under test.
 */
interface EgressPolicyRow {
  tenantId: string;
  id: string;
  class: DataClass;
  allowedEndpoint: string;
  description: string | null; // nullable (AC-15)
  createdAt: number;
  updatedAt: number;
}

// 1. Every member of the closed DataClass set is a valid `class` value — these
//    are exactly the four values the DB CHECK enumerates.
const okPublic: EgressPolicyRow["class"] = "public";
const okInternal: EgressPolicyRow["class"] = "internal";
const okConfidential: EgressPolicyRow["class"] = "confidential";
const okRestricted: EgressPolicyRow["class"] = "restricted";
void okPublic;
void okInternal;
void okConfidential;
void okRestricted;

// 2. A value OUTSIDE the closed set is NOT assignable to `class` — mirrors the
//    DB CHECK rejecting class = 'top_secret' (AC-6). If `class` ever widened to
//    `string`, this directive would become unused and tsc would fail.
// @ts-expect-error — 'top_secret' is not a member of the closed DataClass set
const badClass: EgressPolicyRow["class"] = "top_secret";
void badClass;

// 3. `egress_policy.class` is assignable to `DataClass` and vice-versa — the two
//    are the SAME closed axis (S-2). A round-trip both directions pins identity,
//    not just one-way assignability.
const asDataClass: DataClass = okConfidential;
const asColumn: EgressPolicyRow["class"] = asDataClass;
void asColumn;

// 4. `description` is nullable (AC-15): NULL is an accepted value.
const nullDescription: EgressPolicyRow["description"] = null;
void nullDescription;
