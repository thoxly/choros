/**
 * src/core/changelog-diff-validator.ts
 *
 * T-0084 · E12.3 — Independent changelog↔diff validator + form/schema-compat gate.
 *
 * ADR §9.9 / §11 ("Review-trust surface"): the one-click promote button must NOT
 * rely solely on the producer-derived semantic changelog — the producer is also the
 * author (conflict of interest). This INDEPENDENT validator:
 *   (a) Recomputes the diff from the raw BundleSnapshot bytes WITHOUT calling
 *       deriveSemanticChangelog (avoids tautology — the independent recompute IS the
 *       ground truth; the claimed changelog is checked against it).
 *   (b) Validates the new bundle's form JSON-schema is well-formed when present.
 *   (c) Classifies schema changes as additive/expand (promote-safe) vs
 *       lossy/contract (blocked).
 *
 * WHY INDEPENDENT RECOMPUTE ≠ TAUTOLOGY (the key design guarantee):
 *   - `diffBundleSnapshots` (this module) works directly on the raw snapshot string
 *     fields using a structural diff that is SEPARATE from deriveSemanticChangelog in
 *     bundle-commit.ts. It uses a different representation: a Set-based presence/content
 *     check per member. The claimed changelog is then verified against THAT independent
 *     diff — any member that changed in the diff but is absent from the claimed changelog
 *     (or vice-versa) is flagged as a discrepancy.
 *   - The validator never CALLS deriveSemanticChangelog. It re-implements the diff
 *     logic independently so a bug in the producer's changelog derivation cannot
 *     propagate through (it would show up as a mismatch between claimed and actual).
 *
 * PURE CORE: zero external deps (no node:crypto, no process.env, no pg, no IO,
 * no Date.now, no Math.random). The only imports are from sibling pure-core files.
 *
 * Returns a structured PromoteVerdict:
 *   verdict: "promote-safe" | "blocked"
 *   reasons: string[]   (empty when promote-safe)
 *   warnings: string[]  (non-blocking notes)
 */

import type { BundleSnapshot } from "./bundle-commit.js";
import type { JsonSchemaForClassify } from "./schema-change-classifier.js";
import { classifySchemaChange } from "./schema-change-classifier.js";
import type { AffectedDep } from "./schema-change-classifier.js";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/** Final verdict from the independent validator. */
export interface PromoteVerdict {
  /** "promote-safe" if all checks pass; "blocked" if any hard failure. */
  verdict: "promote-safe" | "blocked";
  /**
   * Hard failures — each one blocks the promote. Non-empty iff verdict="blocked".
   * Human-readable, for display to the client reviewer.
   */
  reasons: string[];
  /**
   * Non-blocking warnings (additive schema changes, minor notes). The promote
   * proceeds, but the reviewer sees these.
   */
  warnings: string[];
}

/** Which bundle member changed (same vocabulary as BundleMember in bundle-commit.ts). */
export type BundleMember =
  | "object_schema"
  | "grants"
  | "bpmn_process"
  | "form_code"
  | "form_json_schema";

/** One independently-computed change entry (parallel to SemanticChange but computed here). */
export interface ActualChange {
  member: BundleMember;
  kind: "added" | "removed" | "updated";
}

/** Claimed changelog entry — the producer's stated changelog item to be verified. */
export interface ClaimedChange {
  /** Which bundle member the producer claims changed. */
  member: BundleMember;
  /**
   * The kind of change the producer claims. Must match the independently-computed
   * kind for the same member (any mismatch is a discrepancy and blocks the promote).
   */
  kind: "added" | "removed" | "updated";
}

/**
 * Optional dependencies for schema-compat check. When provided, the validator
 * runs classifySchemaChange to detect lossy/destructive schema changes against
 * known deps. When absent (empty array or undefined), only basic schema-parse
 * validation is run.
 */
export type ActiveDeps = AffectedDep[];

/**
 * Full input to validateChangelog. All fields required; pass empty activeDeps
 * when no active deps are known.
 */
export interface ValidateChangelogInput {
  /** The old (from) bundle snapshot. */
  fromSnapshot: BundleSnapshot;
  /** The new (to) bundle snapshot. */
  toSnapshot: BundleSnapshot;
  /**
   * The producer's claimed semantic changelog — what the producer says changed.
   * The validator independently recomputes the actual diff and verifies the
   * claimed changelog against it. Falsy/missing entries are treated as "claiming
   * nothing changed" for that member.
   */
  claimedChangelog: ClaimedChange[];
  /**
   * Active dependencies for schema-compat check. Used only when object_schema
   * changed. Pass [] if not known; only basic well-formedness is checked.
   */
  activeDeps: ActiveDeps;
}

// ---------------------------------------------------------------------------
// The five bundle members (ordered, frozen — must match BundleSnapshot keys)
// ---------------------------------------------------------------------------

const BUNDLE_MEMBERS: BundleMember[] = [
  "object_schema",
  "grants",
  "bpmn_process",
  "form_code",
  "form_json_schema",
];

const MEMBER_LABELS: Record<BundleMember, string> = {
  object_schema: "object schema",
  grants: "role/agent grants",
  bpmn_process: "BPMN process definition",
  form_code: "form code",
  form_json_schema: "form JSON-schema",
};

// ---------------------------------------------------------------------------
// Independent diff (the independent recompute — NOT calling deriveSemanticChangelog)
// ---------------------------------------------------------------------------

/**
 * Independently compute which members changed between two BundleSnapshots.
 *
 * This is the GROUND TRUTH diff. It is intentionally implemented separately
 * from deriveSemanticChangelog in bundle-commit.ts so that a bug in the
 * producer's derivation would surface as a mismatch when compared against the
 * claimed changelog.
 *
 * Logic: for each of the five members, compare the string content directly.
 *   - Same string → no change.
 *   - Was empty (""), now non-empty → "added"
 *   - Was non-empty, now empty ("") → "removed"
 *   - Both non-empty, different → "updated"
 */
export function diffBundleSnapshots(
  from: BundleSnapshot,
  to: BundleSnapshot,
): ActualChange[] {
  const changes: ActualChange[] = [];
  for (const member of BUNDLE_MEMBERS) {
    const fromVal = from[member];
    const toVal = to[member];
    if (fromVal === toVal) continue;
    let kind: ActualChange["kind"];
    if (!fromVal && toVal) {
      kind = "added";
    } else if (fromVal && !toVal) {
      kind = "removed";
    } else {
      kind = "updated";
    }
    changes.push({ member, kind });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Form JSON-schema well-formedness check
// ---------------------------------------------------------------------------

/**
 * Validate that a form_json_schema string is well-formed JSON (when non-empty).
 * Returns an error string if invalid, undefined if valid.
 *
 * This is intentionally lightweight: the validator's role is to confirm the
 * schema is parse-able before the bundle is promoted. Deep schema validation
 * belongs to form-validator.ts / form-schema.ts.
 */
function validateFormJsonSchemaWellFormed(formJsonSchema: string): string | undefined {
  if (!formJsonSchema) return undefined; // empty = deferred member, not an error
  try {
    const parsed = JSON.parse(formJsonSchema);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return "form_json_schema must be a JSON object (not array or primitive)";
    }
    return undefined;
  } catch {
    return "form_json_schema is not valid JSON";
  }
}

// ---------------------------------------------------------------------------
// Object schema well-formedness check
// ---------------------------------------------------------------------------

/**
 * Parse object_schema for the schema-compat check. Returns the parsed
 * JsonSchemaForClassify on success, or an error string.
 */
function parseObjectSchema(
  schemaStr: string,
): { ok: true; schema: JsonSchemaForClassify } | { ok: false; error: string } {
  if (!schemaStr) {
    return { ok: true, schema: {} };
  }
  try {
    const parsed = JSON.parse(schemaStr);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: "object_schema must be a JSON object" };
    }
    return { ok: true, schema: parsed as JsonSchemaForClassify };
  } catch {
    return { ok: false, error: "object_schema is not valid JSON" };
  }
}

// ---------------------------------------------------------------------------
// Changelog verification — compare claimed against actual (independent check)
// ---------------------------------------------------------------------------

/**
 * Verify the producer's claimed changelog against the independently-computed
 * actual diff.
 *
 * Rules:
 *   1. Every actual changed member MUST appear in the claimed changelog with the
 *      correct kind. An omission (member changed but not claimed) is a discrepancy
 *      → blocked (the reviewer cannot make an informed decision).
 *   2. Every claimed-change member MUST actually appear in the diff. A spurious
 *      claim (member did not change but is claimed) is also a discrepancy → blocked.
 *   3. Kind mismatches (e.g. claiming "added" when it was "updated") → blocked.
 *
 * Returns an array of human-readable error strings (empty = clean match).
 */
function verifyChangelogAgainstDiff(
  actualChanges: ActualChange[],
  claimedChangelog: ClaimedChange[],
): string[] {
  const errors: string[] = [];

  // Build lookup maps (member → entry)
  const actualMap = new Map<BundleMember, ActualChange["kind"]>();
  for (const ch of actualChanges) {
    actualMap.set(ch.member, ch.kind);
  }
  const claimedMap = new Map<BundleMember, ClaimedChange["kind"]>();
  for (const ch of claimedChangelog) {
    if (claimedMap.has(ch.member)) {
      errors.push(
        `changelog has duplicate entry for member "${ch.member}" — claimed changelog is ambiguous`,
      );
    }
    claimedMap.set(ch.member, ch.kind);
  }

  // Rule 1: actual changes must appear in the claimed changelog
  for (const [member, actualKind] of actualMap) {
    const label = MEMBER_LABELS[member];
    if (!claimedMap.has(member)) {
      errors.push(
        `${label} changed (${actualKind}) but is NOT mentioned in the claimed changelog — omission detected`,
      );
      continue;
    }
    const claimedKind = claimedMap.get(member)!;
    if (claimedKind !== actualKind) {
      errors.push(
        `${label} actually "${actualKind}" but changelog claims "${claimedKind}" — kind mismatch`,
      );
    }
  }

  // Rule 2: claimed changes must be real
  for (const [member, claimedKind] of claimedMap) {
    const label = MEMBER_LABELS[member];
    if (!actualMap.has(member)) {
      errors.push(
        `changelog claims ${label} "${claimedKind}" but the member did NOT change — spurious entry`,
      );
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Main public API — validateChangelog
// ---------------------------------------------------------------------------

/**
 * Independent gate validator for bundle promote.
 *
 * Given (fromSnapshot, toSnapshot, claimedChangelog, activeDeps):
 *   1. Independently recomputes the actual diff from raw snapshot bytes.
 *   2. Verifies the claimed changelog against the actual diff (no omissions,
 *      no spurious claims, no kind mismatches).
 *   3. Validates form_json_schema well-formedness (when non-empty in toSnapshot).
 *   4. Runs schema-compat check on object_schema change against activeDeps
 *      (destructive deps → blocked; soft warnings → warnings[]).
 *
 * Returns a PromoteVerdict:
 *   - promote-safe: all checks pass. Reasons empty.
 *   - blocked: one or more hard failures. Reasons non-empty.
 *   - warnings: non-blocking (additive schema changes, soft type narrowings).
 *
 * PURE: no I/O, no Date.now, no Math.random, no env reads.
 */
export function validateChangelog(input: ValidateChangelogInput): PromoteVerdict {
  const { fromSnapshot, toSnapshot, claimedChangelog, activeDeps } = input;
  const reasons: string[] = [];
  const warnings: string[] = [];

  // Step 1: Independent diff (the ground truth — NOT calling deriveSemanticChangelog)
  const actualChanges = diffBundleSnapshots(fromSnapshot, toSnapshot);

  // Step 2: Verify claimed changelog against actual diff
  const changelogErrors = verifyChangelogAgainstDiff(actualChanges, claimedChangelog);
  for (const e of changelogErrors) {
    reasons.push(`[changelog-mismatch] ${e}`);
  }

  // Step 3: Validate form_json_schema well-formedness in new snapshot
  const formSchemaError = validateFormJsonSchemaWellFormed(toSnapshot.form_json_schema);
  if (formSchemaError) {
    reasons.push(`[form-schema-invalid] ${formSchemaError}`);
  }

  // Step 4: Object-schema compat check (only when object_schema changed)
  const schemaChanged = actualChanges.some((c) => c.member === "object_schema");
  if (schemaChanged) {
    const oldParsed = parseObjectSchema(fromSnapshot.object_schema);
    const newParsed = parseObjectSchema(toSnapshot.object_schema);

    if (!oldParsed.ok) {
      reasons.push(`[schema-parse-error] old object_schema: ${oldParsed.error}`);
    } else if (!newParsed.ok) {
      reasons.push(`[schema-parse-error] new object_schema: ${newParsed.error}`);
    } else {
      // Run the independent schema-change classifier
      const classification = classifySchemaChange(
        oldParsed.schema,
        newParsed.schema,
        activeDeps,
      );

      // Destructive changes → blocked
      for (const dep of classification.destructiveDeps) {
        const fieldDesc = dep.page_slug
          ? `page "${dep.page_slug}" field "${dep.field_key}"`
          : dep.template_slug
          ? `template "${dep.template_slug}" field "${dep.field_key}"`
          : `field "${dep.field_key}"`;
        reasons.push(
          `[schema-destructive] ${fieldDesc} (dep_kind=${dep.dep_kind}) is broken by this schema change — lossy/drop detected`,
        );
      }

      // Soft warnings
      for (const dep of classification.softWarnings) {
        const fieldDesc = dep.page_slug
          ? `page "${dep.page_slug}" field "${dep.field_key}"`
          : dep.template_slug
          ? `template "${dep.template_slug}" field "${dep.field_key}"`
          : `field "${dep.field_key}"`;
        warnings.push(
          `[schema-soft-warning] ${fieldDesc} (dep_kind=${dep.dep_kind}) may be affected by this schema change`,
        );
      }
    }
  }

  const verdict: PromoteVerdict["verdict"] = reasons.length > 0 ? "blocked" : "promote-safe";
  return { verdict, reasons, warnings };
}
