/**
 * T-0032 · Separation-of-Duties (SoD) — static + dynamic, as queries over the
 * ledger and role assignments (E4.2). Pure TS, no DB/IO/LLM.
 *
 * This is the SoD evaluation layer the gateway's step 3.6 calls. It is the exact
 * structural analogue of `effect-resource.ts` (T-0034): a sibling PURE module
 * imported by `grant-resolver.ts`, NOT a second authorization subsystem. The one
 * decision core stays `resolveFor`; SoD adds one additive branch there.
 *
 * Three non-negotiable invariants (inherited from T-0021/T-0033/T-0034 + red-lines):
 *  - Pure / static-now — no pg/fs/net/http import; all state via injected ports
 *    (SodSource, the T-0019 ActorEventReader/ActorEventWriter). The Postgres DAO
 *    lands in T-0053 (ADR §2.1). The static/dynamic decision functions are
 *    deterministic: equal inputs ⇒ deep-equal output (the only async is the
 *    injected reader).
 *  - Fail-closed (NF-3) — ANY doubt (malformed constraint/scope, unreadable
 *    ledger via the port, ambiguous attribution) resolves to a VIOLATION, never
 *    a silent pass. The guarded op is denied.
 *  - No parallel SoD-authority store — SoD constraints are DECLARATIONS; the
 *    decision derives from them + effective role_assignment rows + the
 *    actor_event ledger. No _acl / sod_visibility / sodRights / sodAcl token.
 *
 * SoD is queries-only — NO new derived state: static SoD is a query over
 * effective role_assignment rows; dynamic SoD is recomputed from actor_event at
 * action-time (TOCTOU-safe, like the grant check). The only new table is
 * sod_constraint (the declarations — migration 027), never a decision cache.
 *
 * Semantic contract: docs/design/T-0032-sod-constraints.adr.md §2, §4.
 */

import {
  type ActorEventObjectRef,
  type ActorEventReader,
  type ActorEventRow,
  type ActorEventVerb,
  type ActorEventWriter,
  actorEventPrincipal,
} from "./actor-event.js";
import {
  type AncestryOracle,
  type ScopeElement,
  isBottom,
  meet,
} from "./grant-lattice.js";

// Re-export the in-memory store factory so FR-12's "consumable without
// re-declaration" holds even though the mutable store lives in a sibling module
// (keeping sod.ts a pure-decision module — ADR §4.1 architect note).
export {
  InMemoryActorEventStore,
  makeInMemoryActorEventStore,
  ActorEventValidationError,
} from "./actor-event-store.js";

// ---------------------------------------------------------------------------
// Closed SoD-kind axis (mirrors the migration-027 CHECK; AC-1)
// ---------------------------------------------------------------------------

/** The CLOSED SoD-kind set. Mirrors the `kind IN ('static','dynamic')` CHECK. */
export type SodKind = "static" | "dynamic";

/** Total predicate: is `value` a member of the closed SodKind set? */
export function isSodKind(value: unknown): value is SodKind {
  return value === "static" || value === "dynamic";
}

// ---------------------------------------------------------------------------
// Types — the declaration row, effective assignments, the guarded act
// ---------------------------------------------------------------------------

/**
 * A SoD constraint DECLARATION row (TS mirror of choros.sod_constraint).
 *  - static:  role_a & role_b are the incompatible pair (both non-null — the
 *             sod_constraint_static_shape CHECK enforces it at the DB layer).
 *  - dynamic: the conflicting-verb / self-record separation; role_a MAY be null.
 *  - scope:   a grant-lattice ScopeElement-shaped jsonb whose containment of the
 *             object is tested via the AncestryOracle (opaque to the loader DAO).
 */
export interface SodConstraint {
  tenantId: string;
  id: string;
  kind: SodKind;
  roleA: string | null; // role uuid; non-null for static
  roleB: string | null; // role uuid; non-null for static
  selfRecord: boolean; // dynamic self-record separation flag
  scope: unknown; // ScopeElement-shaped; opaque to the loader
  detail?: Record<string, unknown> | null;
}

/**
 * An EFFECTIVE role assignment, as the static-SoD query consumes it. The
 * effectiveness predicate (confirmed_by NOT NULL ∧ in validity-window ∧
 * org_scope containment — T-0022) is applied by the SodSource DAO (T-0053) /
 * the in-memory source — NEVER here. sod.ts is pure decision logic.
 */
export interface EffectiveAssignment {
  employeeId: string;
  roleId: string;
  orgScope: unknown; // ScopeElement-shaped; intersected with the constraint scope
}

/**
 * The injected loader port (pure static-now; Postgres DAO in T-0053). Returns
 * only EFFECTIVE assignments and active constraints — the effectiveness filter
 * lives in the DAO, never in sod.ts. Carries the T-0019 reader (dynamic-SoD
 * substrate) + writer (the guarded append).
 */
export interface SodSource {
  /** All active SoD constraints in the tenant whose scope MAY cover the object. */
  constraintsFor(ref: ActorEventObjectRef): Promise<SodConstraint[]>;
  /** Effective assignments for one principal (confirmed, in-window) — static SoD. */
  effectiveAssignmentsOf(principal: string): Promise<EffectiveAssignment[]>;
  /** The T-0019 reader (dynamic SoD substrate) over the per-object trail. */
  reader: ActorEventReader;
  /** The T-0019 writer (the guarded append on a PASS). */
  writer: ActorEventWriter;
}

/**
 * The act the gateway records on a PASS (the writer input minus tenant/seq/id).
 * Built from the resolver's GuardContext + the handle's ref at action-time.
 */
export interface GuardedAct {
  ref: ActorEventObjectRef; // the object the transition targets
  actor: string; // performer (employee id)
  onBehalfOf?: string | null; // principal when ≠ performer
  roleAtEvent: string; // the role the gateway resolved the actor under
  event: ActorEventVerb; // the verb (e.g. 'approve')
  approveLevel?: number; // required iff event === 'approve'
}

/** SoD decision result (pure). A violation names the constraint + the rule. */
export type SodDecision =
  | { violated: false }
  | { violated: true; constraintId: string; rule: "static" | "dsod1" | "dsod2" };

/**
 * The denied-view extension carrying the new `"sod_violation"` reason. Defined
 * HERE because `object-handle.ts` is frozen (mirrors T-0034's EffectDeniedView);
 * `resolveFor`'s return type is widened to include it. Downstream `reason`
 * switches handle the new literal via their default/wildcard branch
 * (backward-compatible widening — ADR §5).
 */
export interface SodDeniedView {
  denied: true;
  reason: "sod_violation";
}

// ---------------------------------------------------------------------------
// Scope intersection — no new algebra (reuses the T-0018 meet over the oracle)
// ---------------------------------------------------------------------------

/**
 * Total predicate: is `value` a well-formed grant-lattice ScopeElement? A
 * structural guard so the opaque (`unknown`) constraint/assignment scopes are
 * validated before the lattice `meet` is applied. Conservative — it only checks
 * the discriminant shape the four ScopeElement kinds require.
 */
function isScopeElement(value: unknown): value is ScopeElement {
  if (typeof value !== "object" || value === null) return false;
  const k = (value as { kind?: unknown }).kind;
  switch (k) {
    case "node":
      return (
        typeof (value as { hierarchy?: unknown }).hierarchy === "string" &&
        typeof (value as { nodeId?: unknown }).nodeId === "string" &&
        typeof (value as { nodeLevel?: unknown }).nodeLevel === "string"
      );
    case "tags":
      return Array.isArray((value as { tags?: unknown }).tags);
    case "interval":
      return (
        typeof (value as { axis?: unknown }).axis === "string" &&
        typeof (value as { lo?: unknown }).lo === "number" &&
        typeof (value as { hi?: unknown }).hi === "number"
      );
    case "set":
      return Array.isArray((value as { members?: unknown }).members);
    default:
      return false;
  }
}

/**
 * Do two (opaque) scopes intersect? Reuses the T-0018 `meet` (greatest lower
 * bound) over the injected AncestryOracle — NO new scope algebra: two scopes
 * intersect iff their meet is not ⊥. FAIL-CLOSED (NF-3): if either scope is not
 * a well-formed ScopeElement, the doubt resolves to "they DO intersect" so the
 * static constraint is treated as potentially-violated (a malformed scope can
 * never PROVE the assignments are disjoint, so it cannot clear SoD).
 */
function scopesIntersect(
  a: unknown,
  b: unknown,
  ancestry: AncestryOracle,
): boolean {
  if (!isScopeElement(a) || !isScopeElement(b)) {
    return true; // fail-closed: undecidable overlap counts as overlap.
  }
  return !isBottom(meet(a, b, ancestry));
}

// ---------------------------------------------------------------------------
// Static SoD — incompatible roles over EFFECTIVE assignments (FR-2, FR-10)
// ---------------------------------------------------------------------------

/**
 * Static-SoD detection (FR-2, AC-2/AC-3). Pure.
 *
 * Given the principal's EFFECTIVE assignments and the active static constraints,
 * report the first incompatible pair whose scope intersects. A violation = the
 * same principal holds an assignment to role_a AND an assignment to role_b, and
 * BOTH assignments' org_scope intersect the constraint scope (FR-2).
 *
 * Only `kind === 'static'` constraints participate; a static constraint with a
 * null role (which the DB CHECK forbids, but a malformed in-memory/forged row
 * could carry) is treated FAIL-CLOSED as a violation (NF-3) — a constraint we
 * cannot evaluate cannot be proven clear. Effectiveness is the DAO's job
 * (effectiveAssignmentsOf returns only effective rows), so a proposal /
 * out-of-window / non-covering assignment is simply absent here.
 */
export function detectStaticConflict(
  assignments: EffectiveAssignment[],
  constraints: SodConstraint[],
  ancestry: AncestryOracle,
): SodDecision {
  for (const c of constraints) {
    if (c.kind !== "static") continue;
    if (c.roleA === null || c.roleB === null) {
      // Malformed static constraint (DB CHECK forbids it) — fail-closed.
      return { violated: true, constraintId: c.id, rule: "static" };
    }
    const holdsA = assignments.filter(
      (a) => a.roleId === c.roleA && scopesIntersect(a.orgScope, c.scope, ancestry),
    );
    const holdsB = assignments.filter(
      (a) => a.roleId === c.roleB && scopesIntersect(a.orgScope, c.scope, ancestry),
    );
    if (holdsA.length > 0 && holdsB.length > 0) {
      return { violated: true, constraintId: c.id, rule: "static" };
    }
  }
  return { violated: false };
}

/**
 * The FR-10 standalone form (AC-3/FR-10). Pure. Would confirming
 * `(employee, candidate)` create a static-SoD violation against the principal's
 * EXISTING effective assignments? Same core as detectStaticConflict, with the
 * candidate assignment folded in — the assignment-conflict detector E4.6 keys on
 * (T-0032 ships the QUERY, not the assignment-time block).
 */
export function wouldCreateStaticConflict(
  existing: EffectiveAssignment[],
  candidate: { roleId: string; orgScope: unknown },
  constraints: SodConstraint[],
  ancestry: AncestryOracle,
): SodDecision {
  // The candidate principal is the existing set's employee (a single principal);
  // fold the candidate in as a synthetic effective assignment and re-run static.
  const employeeId = existing[0]?.employeeId ?? "candidate";
  const folded: EffectiveAssignment[] = [
    ...existing,
    { employeeId, roleId: candidate.roleId, orgScope: candidate.orgScope },
  ];
  return detectStaticConflict(folded, constraints, ancestry);
}

// ---------------------------------------------------------------------------
// Dynamic SoD — over the actor-event ledger (FR-3, FR-8, FR-9)
// ---------------------------------------------------------------------------

/**
 * The earlier verbs that DSoD-1 treats as conflicting with a guarded
 * approve/transition (spec §3.2): a principal who performed any of these on the
 * object may not perform the guarded act. `approve` is handled by DSoD-2 (level
 * separation), not here.
 */
const DSOD1_CONFLICTING_VERBS: readonly ActorEventVerb[] = [
  "request",
  "prepare",
  "submit",
];

/**
 * Dynamic-SoD decision (FR-3, FR-8, FR-9, AC-4..AC-7). Async only because it
 * reads the ledger via the injected ActorEventReader; the decision logic itself
 * is deterministic given the trail.
 *
 *  - DSoD-1 (self-approval / separation-of-duty): a principal who performed a
 *    conflicting earlier verb (request/prepare/submit) on the object may not
 *    perform the guarded approve/transition (AC-4). Evaluated via
 *    didPrincipalPerform on the acting PRINCIPAL.
 *  - DSoD-2 (multi-level approval separation): the principal who performed
 *    `approve` at level n may not perform `approve` at a different level m≠n on
 *    the same object (AC-5). Evaluated over the trail filtered to `event==='approve'`,
 *    comparing approveLevel and COALESCE(onBehalfOf, actor).
 *  - Attribution throughout = COALESCE(onBehalfOf, actor) (actorEventPrincipal,
 *    AC-6/AC-7): a delegated act (X on_behalf_of P) collides with P's submit; a
 *    self-act by X does not. Two acts attributed to the SAME principal collide
 *    regardless of who physically performed them.
 *
 * Only `kind === 'dynamic'` constraints participate.
 */
export async function evaluateDynamicSod(
  reader: ActorEventReader,
  constraints: SodConstraint[],
  act: GuardedAct,
): Promise<SodDecision> {
  const principal = actorEventPrincipal({
    actor: act.actor,
    onBehalfOf: act.onBehalfOf,
  });

  for (const c of constraints) {
    if (c.kind !== "dynamic") continue;

    // DSoD-1: the acting principal must not have performed a conflicting earlier
    // verb on this object. Only meaningful when the guarded act is the approving
    // / transitioning act (which the gateway gates to op ∈ {approve, transition}).
    for (const verb of DSOD1_CONFLICTING_VERBS) {
      const performed = await reader.didPrincipalPerform(act.ref, verb, principal);
      if (performed) {
        return { violated: true, constraintId: c.id, rule: "dsod1" };
      }
    }

    // DSoD-2: the acting principal must not have already approved this object at
    // a DIFFERENT level. Only checked for an `approve` guarded act (level-keyed).
    if (act.event === "approve") {
      const trail = await reader.trail(act.ref);
      const priorApprovals = trail.filter(
        (r: ActorEventRow) =>
          r.event === "approve" &&
          actorEventPrincipal({ actor: r.actor, onBehalfOf: r.onBehalfOf }) ===
            principal,
      );
      for (const prior of priorApprovals) {
        // Same principal approving at a DIFFERENT level on the same object.
        if (prior.approveLevel !== (act.approveLevel ?? null)) {
          return { violated: true, constraintId: c.id, rule: "dsod2" };
        }
      }
    }
  }

  return { violated: false };
}

// ---------------------------------------------------------------------------
// The top-level guard the resolver calls (step 3.6)
// ---------------------------------------------------------------------------

/**
 * The top-level SoD guard the resolver's step 3.6 calls (FR-6). Loads the
 * active constraints, runs static + dynamic, returns the decision. FAIL-CLOSED
 * (NF-3): any thrown port error / malformed constraint ⇒ `{ violated: true }`,
 * never a silent pass.
 *
 * `principalAssignments` is passed in (the resolver already fetched it via
 * `effectiveAssignmentsOf` so the same instant is used) — keeping this function
 * deterministic given its inputs + the injected reader (AC-20).
 */
export async function evaluateSod(
  source: SodSource,
  ancestry: AncestryOracle,
  act: GuardedAct,
  principalAssignments: EffectiveAssignment[],
): Promise<SodDecision> {
  let constraints: SodConstraint[];
  try {
    constraints = await source.constraintsFor(act.ref);
  } catch {
    return { violated: true, constraintId: "<load-error>", rule: "static" };
  }

  // Static SoD over the principal's effective assignments.
  const staticDecision = detectStaticConflict(
    principalAssignments,
    constraints,
    ancestry,
  );
  if (staticDecision.violated) return staticDecision;

  // Dynamic SoD over the actor_event trail (via the injected reader).
  try {
    return await evaluateDynamicSod(source.reader, constraints, act);
  } catch {
    return { violated: true, constraintId: "<read-error>", rule: "dsod1" };
  }
}
