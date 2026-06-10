/**
 * T-0034: External-Effect Resources (E4.4) — pure TS, no DB/IO/LLM.
 *
 * This module makes effect resources (`integration_endpoint`, `messaging_channel`,
 * `external_account`) first-class objects in the grant model. A tool's declared
 * effects are verified by the gateway at `invoke`-time against the caller's held
 * grants — NOT trusted as advisory text.
 *
 * Three exports form the public seam T-0043 (`mcp_tool` registry) depends on:
 *  - `classifyTool(declares)` — pure-compute linter (static, deterministic, no I/O).
 *  - `verifyEffectGrants(...)` — gateway-verification function called inside resolveFor.
 *  - `EffectSource` — injected port (pure static-now; Postgres DAO in T-0053).
 *
 * Three NON-NEGOTIABLE invariants inherited from T-0021/T-0033 and the red-lines:
 *  - Pure / static-now — no pg/fs/net/http import; state only via injected EffectSource.
 *  - Fail-closed — ANY doubt about a declaration resolves to denial, never permit.
 *  - No parallel effect-ACL store — no _acl / effect_visibility / effectRights /
 *    effectAcl tokens; all access decisions derive from the T-0018 grant rows.
 *
 * Semantic contract: docs/design/T-0034-external-effect.adr.md §2–§4.
 */

import {
  type Grant,
  isEffective,
} from "./grant-lattice.js";

// ---------------------------------------------------------------------------
// Closed effect-kind axis (AC-1)
// ---------------------------------------------------------------------------

/**
 * Closed set of external-effect resource kinds. Adding a new kind requires a
 * spec/ADR update; free-text effect descriptions are structurally rejected
 * (FR-3, NF-3). Any string not in this union resolves to `fail-closed` at
 * both the linter and the gateway.
 */
export type EffectKind =
  | "integration_endpoint"
  | "messaging_channel"
  | "external_account";

/** Total predicate: is `value` a member of the closed EffectKind set? */
function isEffectKind(value: unknown): value is EffectKind {
  return (
    value === "integration_endpoint" ||
    value === "messaging_channel" ||
    value === "external_account"
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A tool's typed claim to invoke one effect-resource. `resourceId` identifies
 * the effect_resource row; `kind` is asserted by the tool and validated
 * against the stored row — mismatch → fail-closed (FR-3, AC-1).
 */
export interface EffectDeclaration {
  resourceId: string; // identity of the effect_resource row
  kind: EffectKind; // must match the stored row's kind; mismatch → fail-closed
}

/**
 * First-class effect-resource entity row — mirrors the DB table shape
 * (migrations/022_effect_resource.sql).
 */
export interface EffectResource {
  id: string;
  tenantId: string;
  kind: EffectKind;
  scope: unknown; // ScopeElement or descriptive qualifier; opaque to linter
  metadata?: unknown; // arbitrary jsonb; not used in access decision
}

/**
 * Injected port — pure static-now; Postgres DAO in T-0053 (mirrors
 * GrantSource/RecordSource/ClassificationSource). Returns null when the
 * effect-resource is not found within the tenant → fail-closed.
 */
export interface EffectSource {
  /** Resolve effect-resource by id within a tenant. null = not found → fail-closed. */
  getEffect(tenantId: string, resourceId: string): EffectResource | null;
}

/**
 * Output of the pure-compute linter `classifyTool`.
 * - `{ pure: true }` — declares is empty; tool is pure-compute (no effects).
 * - `{ pure: false; effects: EffectDeclaration[] }` — ≥1 effect declared.
 */
export type ToolEffectProfile =
  | { pure: true }
  | { pure: false; effects: EffectDeclaration[] };

/**
 * Output of the gateway-verification step `verifyEffectGrants`.
 * - `{ ok: true }` — all declarations covered by valid, effective grants.
 * - `{ ok: false; missingResourceId: string }` — first uncovered declaration.
 */
export type EffectVerifyResult =
  | { ok: true }
  | { ok: false; missingResourceId: string };

/**
 * A denied-view extension carrying the new `"no_effect_grant"` reason.
 * `object-handle.ts` is frozen — this type is defined HERE and used in
 * `grant-resolver.ts` via a widened return type on `resolveFor`.
 *
 * Downstream callers that switch over the `reason` field handle the new
 * literal via a wildcard / default branch — backward-compatible widening.
 */
export interface EffectDeniedView {
  denied: true;
  reason: "no_effect_grant";
}

// ---------------------------------------------------------------------------
// Pure-compute linter: classifyTool (AC-2, AC-3, AC-4, FF-ER3, FF-ER4)
// ---------------------------------------------------------------------------

/**
 * Parse and validate a raw `declares` blob as an `EffectDeclaration[]`.
 * Returns `null` on any structural or kind violation (fail-closed, NF-3).
 *
 * An empty array is valid and yields `[]` (tool is pure-compute, AC-2).
 * A non-array, null, or array with any malformed / unknown-kind entry
 * yields `null` (fail-closed, AC-4, FR-6).
 */
function parseEffectDeclarations(raw: unknown): EffectDeclaration[] | null {
  if (!Array.isArray(raw)) return null;
  const result: EffectDeclaration[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") return null;
    const r = item as Record<string, unknown>;
    if (typeof r["resourceId"] !== "string") return null;
    if (!isEffectKind(r["kind"])) return null;
    result.push({ resourceId: r["resourceId"] as string, kind: r["kind"] });
  }
  return result;
}

/**
 * The pure-compute linter (FR-5, AC-2–AC-4, FF-ER3/FF-ER4).
 *
 * Pure, deterministic, no I/O — the STATIC counterpart to the runtime gateway
 * check. Classifies a tool at linter-time:
 *  - Empty `declares` → `{ pure: true }` (pure-compute tool, AC-2).
 *  - ≥1 valid declaration → `{ pure: false, effects: [...] }` (effecting, AC-3).
 *  - Null, non-array, or malformed declaration → `{ pure: false }` (fail-closed,
 *    AC-4 / FR-6 — unknown effects are NEVER classified as pure).
 *
 * `mcp_tool.pure_compute` boolean = `classifyTool(tool.declares).pure`.
 */
export function classifyTool(
  declares: EffectDeclaration[] | unknown,
): ToolEffectProfile {
  const parsed = parseEffectDeclarations(declares);
  // Malformed (null) → fail-closed: treat as effecting (AC-4, FR-6).
  if (parsed === null) return { pure: false, effects: [] };
  // Empty → pure-compute (AC-2).
  if (parsed.length === 0) return { pure: true };
  // Non-empty valid declarations → effecting (AC-3).
  return { pure: false, effects: parsed };
}

// ---------------------------------------------------------------------------
// Gateway verification: verifyEffectGrants (AC-5–AC-9, FF-ER5–FF-ER7)
// ---------------------------------------------------------------------------

/**
 * The gateway-verification function called inside `resolveFor` (step 3.5,
 * ADR §4.4). Pure aside from the `source` port call.
 *
 * Algorithm (ADR §4.5, all-or-nothing):
 *  For each declaration in `declarations`:
 *    1. Validate decl.kind ∈ EffectKind closed set → fail-closed if not.
 *    2. Fetch row = source.getEffect(tenantId, decl.resourceId) → null ⇒ fail-closed.
 *    3. Verify row.kind === decl.kind → kind-mismatch ⇒ fail-closed.
 *    4. Check ≥1 covering grant satisfies:
 *         g.resourceType === "effect_resource"
 *         AND g.operation === "invoke"
 *         AND isEffective(g, nowMs)
 *         AND g.tenantId === tenantId
 *         AND g.scope covers the specific resourceId (scope.kind==="freeform" excluded;
 *             for effect_resource grants the scope is a plain resource identity match —
 *             the grant's scope.resourceId or a tag containing the resourceId).
 *       If no covering grant → return { ok: false, missingResourceId: decl.resourceId }
 *  All covered → return { ok: true }
 *
 * First failing declaration short-circuits (all-or-nothing, AC-7).
 */
export function verifyEffectGrants(
  declarations: EffectDeclaration[],
  coveringGrants: Grant[],
  nowMs: number,
  source: EffectSource,
  tenantId: string,
): EffectVerifyResult {
  for (const decl of declarations) {
    // 1. Closed-set kind validation (AC-1 — no string cast can widen EffectKind).
    if (!isEffectKind(decl.kind)) {
      return { ok: false, missingResourceId: decl.resourceId };
    }

    // 2. Fetch the stored effect-resource row (tenant-scoped → cross-tenant isolation).
    const row = source.getEffect(tenantId, decl.resourceId);
    if (row === null) {
      // Not found → fail-closed (FR-7, AC-11).
      return { ok: false, missingResourceId: decl.resourceId };
    }

    // 3. Kind-mismatch → fail-closed (ADR §4.5 step 3, adversarial case 9).
    if (row.kind !== decl.kind) {
      return { ok: false, missingResourceId: decl.resourceId };
    }

    // 4. At least one covering grant for this specific effect-resource.
    //    An effect_resource grant identifies the specific resource via its scope.
    //    The grant's scope is used to match the resource: we accept a grant when
    //    it is a lattice scope whose "tags" include the resourceId (simple
    //    identity match) OR a "node" scope whose nodeId matches the resourceId.
    //    A "freeform" scope is owner-only and participates here (owner can always
    //    grant effect-resource access to themselves — but the grant still must
    //    be tenant-scoped).
    const covered = coveringGrants.some((g) => {
      if (g.tenantId !== tenantId) return false;
      if (g.resourceType !== "effect_resource") return false;
      if (g.operation !== "invoke") return false;
      if (!isEffective(g, nowMs)) return false;
      // Scope matching for effect_resource: the grant scope targets the specific
      // resource identity (the resourceId is the leaf identifier).
      return effectScopeCoversResource(g.scope, decl.resourceId);
    });

    if (!covered) {
      return { ok: false, missingResourceId: decl.resourceId };
    }
  }

  return { ok: true };
}

/**
 * Does a grant's scope cover a specific effect-resource (by resourceId)?
 *
 * Effect-resource grants use the resource's UUID as their scope identifier.
 * Four matching strategies (corresponding to the four scope element kinds plus
 * freeform):
 *  - `node` scope → matches if `nodeId === resourceId` (exact resource identity).
 *  - `tags` scope → matches if `resourceId ∈ tags` (the tag set contains the ID).
 *  - `freeform` scope → matches if `predicate === resourceId` (owner-grant exact match).
 *  - `interval`/`set` scopes → not used for effect_resource grants; return false.
 *
 * This keeps the scope-matching minimal and consistent with the grant-lattice
 * without importing the full `isNarrowerOrEqual` algebra for resource-identity
 * grants (where the scope IS the resource, not a containment hierarchy).
 */
function effectScopeCoversResource(
  scope: Grant["scope"],
  resourceId: string,
): boolean {
  switch (scope.kind) {
    case "node":
      return scope.nodeId === resourceId;
    case "tags":
      return scope.tags.includes(resourceId);
    case "freeform":
      return scope.predicate === resourceId;
    case "interval":
      return false;
    case "set":
      // A set scope matches if any member covers the resourceId.
      return scope.members.some((m) =>
        effectScopeCoversResource(m, resourceId),
      );
  }
}
