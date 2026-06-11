/**
 * src/core/dual-control.ts — T-0044 E4.6: Dual-control gate keyed to criticality
 * (signed D-A = A3). Pure TS, zero IO, zero migration, zero new authority store.
 *
 * The gate decides, for a proposed grant/role-assignment change, **how many**
 * distinct approvers are required (1 or 2) and whether a supplied distinct
 * approver set **satisfies** the gate. Two approvers are required iff the
 * EFFECTIVE (compiled) criticality of the role ESCALATES from→to
 * (`criticalityDiff(from,to).escalates === true`, T-0040 FROZEN contract) OR the
 * Q-2 fail-closed implicit-escalate fires (a non-derivable clearance token on a
 * newly-added read grant). Else a single scoped approver suffices.
 *
 * NON-NEGOTIABLE invariants (NF-1..NF-7, ADR §2):
 *  - **Single source of criticality (FR-8, AC-13):** `criticalityDiff` /
 *    `combineCriticality` / `RoleCriticality` / `CriticalityDiff` are IMPORTED
 *    from `./role-criticality.js`; the three axis bits are NEVER re-derived here.
 *  - **Pure / no IO (NF-1):** no `pg`/`fs`/`net`/`http`; the only import beyond
 *    role-criticality is the FROZEN `Grant`/`isEffective` (grant-lattice) for the
 *    Q-2 detector + the FROZEN `DataClass` axis (`DATA_CLASS_ORDER`,
 *    data-classification) to ask "is this token a derivable DataClass?".
 *  - **Determinism (NF-3):** no `Date.now()`/`new Date()`; `nowMs` is a
 *    parameter. Equal inputs ⇒ deep-equal output.
 *  - **Fail-closed bias (NF-2):** ambiguity resolves toward MORE control — a
 *    garbage clearance forces two approvers; a malformed input denies.
 *  - **WORM audit via the canonical writer (NF-7):** the gate constructs a thin
 *    `AuditEventInput` (T-0031 contract) — it adds NO new audit writer; the
 *    call-site appends it via the existing `appendAuditEventInput`.
 *  - **Authenticated-only approvers (R-AUTH, rev-2 §9):** this pure core is
 *    identity-agnostic — it only counts distinct ids. The call-site (grants.ts)
 *    sources every id from `extractActor`; the body never asserts an approver.
 *
 * SoD boundary (AC-18): this module does NOT read/write `sod_constraint` and
 * does NOT call the T-0032 SoD evaluator. Dual-control and SoD are orthogonal.
 *
 * Semantic contract: docs/design/T-0044-dual-control.adr.md §2–§3 (+ rev-2 §9).
 */

import {
  type RoleCriticality,
  type CriticalityDiff,
  criticalityDiff,
} from "./role-criticality.js";
import { type Grant } from "./grant-lattice.js";
import { type DataClass, DATA_CLASS_ORDER } from "./data-classification.js";
import { type AuditEventInput } from "./audit-grant-encoder.js";

// ---------------------------------------------------------------------------
// Gate input / output contracts (ADR §3.1–§3.3)
// ---------------------------------------------------------------------------

/**
 * Gate input (pure). `from`/`to` are the COMPILED `RoleCriticality` (via
 * `combineCriticality`) of the role's effective grants BEFORE and AFTER the
 * proposed change — never a literal row delta (FR-4). `approvers` are the
 * supplied distinct approver principal ids (may carry dups/the proposer; the
 * gate collapses them). `addedReadGrants` is the Q-2 fail-closed probe input:
 * the READ grants the change ADDS (empty/absent ⇒ no implicit escalate).
 */
export interface DualControlInput {
  from: RoleCriticality;
  to: RoleCriticality;
  proposedBy: string;
  approvers: string[];
  addedReadGrants?: Grant[];
}

/** Gate output (FR-1). */
export interface DualControlDecision {
  required_approvers: 1 | 2;
  distinct_ok: boolean;
  satisfied: boolean;
  reason: DualControlReason;
}

/** Stable machine reason strings (deterministic — ADR §3.3). */
export type DualControlReason =
  | "escalates_criticality"
  | "implicit_escalate_clearance"
  | "routine_change"
  | "satisfied"
  | "insufficient_distinct_approvers"
  | "malformed_input";

// ---------------------------------------------------------------------------
// ConfirmationFlag — DERIVED in-request record (Q-1, FR-5). NO table backs it.
// ---------------------------------------------------------------------------

export type ConfirmationFlagStatus = "pending" | "satisfied" | "rejected";

export interface ConfirmationFlag {
  change_ref: string;
  effective_diff: CriticalityDiff;
  approvers: string[];
  status: ConfirmationFlagStatus;
}

// ---------------------------------------------------------------------------
// Q-2 detector — non-derivable clearance on an added read grant (fail-closed)
// ---------------------------------------------------------------------------

/**
 * Is `value` a member of the closed `DataClass` set? Asks the FROZEN
 * data-classification axis (`DATA_CLASS_ORDER`) — it does NOT re-derive axis c;
 * it only answers "is this token a valid DataClass token?". (`isDataClass` is
 * module-private to data-classification.ts, so we reuse the exported ordering
 * rather than re-implementing the axis — single source of the closed vocabulary.)
 */
function isDerivableDataClass(value: unknown): value is DataClass {
  return (
    typeof value === "string" &&
    DATA_CLASS_ORDER.indexOf(value as DataClass) >= 0
  );
}

/**
 * Read a grant's clearance MARKER value, if a `clearance` key is present on the
 * grant's opaque `constraint` (preferred) or `resourceFacet` (fallback) surface.
 * Returns `{ present: false }` when no clearance key exists at all (a public /
 * internal read confers no sensitivity — NOT an escalate, spec-conformant to
 * T-0040), or `{ present: true, value }` when a clearance key IS present (its
 * value may or may not be a derivable DataClass). Mirrors the clearance-marker
 * read shape of the FROZEN `data-classification.grantClearance`, but reports
 * PRESENCE (so a present-but-garbage token is distinguishable from absence).
 */
function readClearancePresence(
  opaque: unknown,
): { present: false } | { present: true; value: unknown } {
  if (opaque === null || typeof opaque !== "object") return { present: false };
  const rec = opaque as Record<string, unknown>;
  if (!("clearance" in rec)) return { present: false };
  return { present: true, value: rec["clearance"] };
}

/**
 * Q-2 (ADR §1 / §3.6): TRUE iff any supplied added READ grant carries a
 * clearance KEY whose VALUE is PRESENT but NOT a derivable `DataClass` (a
 * garbage token). This closes the T-0040 R-1 under-flag: axis c inherits
 * T-0033 `deriveClearance` quiet-null, so a garbage clearance silently resolves
 * to `sensitive_read = false` (under-flag). The gate's fail-closed stance
 * (NF-2, "doubt → MORE criticality") forces dual-control instead. Pure; reuses
 * the FROZEN DataClass vocabulary only. A read grant with NO clearance key is
 * NOT an escalate; only a present-but-unparseable token escalates.
 */
export function nonDerivableReadClearance(addedReadGrants: Grant[]): boolean {
  for (const g of addedReadGrants) {
    // Only READ grants carry a sensitivity-bearing clearance (axis c is keyed
    // on operation === "read"); a clearance marker on a non-read op is inert.
    if (g.operation !== "read") continue;
    for (const surface of [g.constraint, g.resourceFacet]) {
      const marker = readClearancePresence(surface);
      if (marker.present && !isDerivableDataClass(marker.value)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The pure gate decision (FR-1/2/3/14)
// ---------------------------------------------------------------------------

/** A RoleCriticality is well-formed iff its three axis bits are booleans and
 *  `level` is a known level. Fail-closed: a malformed record denies (NF-2). */
function isWellFormedCriticality(c: unknown): c is RoleCriticality {
  if (c === null || typeof c !== "object") return false;
  const r = c as Record<string, unknown>;
  return (
    typeof r["approve_or_transition"] === "boolean" &&
    typeof r["external_invoke"] === "boolean" &&
    typeof r["sensitive_read"] === "boolean" &&
    (r["level"] === "routine" || r["level"] === "critical")
  );
}

/**
 * The pure, deterministic gate decision (FR-1). `required_approvers === 2` iff
 * `criticalityDiff(from,to).escalates === true` OR the Q-2 implicit-escalate
 * fires; else `1`. `satisfied` enforces the distinctness invariant (FR-3):
 * dedupe the approvers, drop any equal to `proposedBy`, and require ≥
 * `required_approvers` survivors. Fail-closed (NF-2): a malformed `from`/`to`
 * or a non-array `approvers` denies with `reason === "malformed_input"` — never
 * a satisfiable single-approver result.
 */
export function dualControlDecision(
  input: DualControlInput,
): DualControlDecision {
  const { from, to, proposedBy, approvers, addedReadGrants } = input;

  // Fail-closed input validation (NF-2 / AC-14): a malformed gate input denies
  // outright. We do NOT fall through to a permissive single-approver path.
  if (
    !isWellFormedCriticality(from) ||
    !isWellFormedCriticality(to) ||
    typeof proposedBy !== "string" ||
    proposedBy.length === 0 ||
    !Array.isArray(approvers) ||
    !approvers.every((a) => typeof a === "string")
  ) {
    return {
      required_approvers: 2, // deny toward MORE control (fail-closed)
      distinct_ok: false,
      satisfied: false,
      reason: "malformed_input",
    };
  }

  // Two-approver trigger — keyed ONLY on the frozen T-0040 diff (FR-2), OR the
  // Q-2 fail-closed implicit escalate (independent of from.level — a garbage
  // clearance is a fail-closed signal, not a level transition, ADR §2.1).
  const diff = criticalityDiff(from, to);
  const implicitEscalate = nonDerivableReadClearance(addedReadGrants ?? []);
  const required_approvers: 1 | 2 =
    diff.escalates || implicitEscalate ? 2 : 1;

  // Distinctness invariant (FR-3, §3.7): D = unique(approvers) \ {proposedBy}.
  const distinct = new Set<string>();
  for (const a of approvers) {
    if (a !== proposedBy) distinct.add(a);
  }
  const satisfied = distinct.size >= required_approvers;

  let reason: DualControlReason;
  if (!satisfied) {
    reason = "insufficient_distinct_approvers";
  } else {
    reason = "satisfied";
  }
  // The "why two approvers" rationale is also carried out-of-band by the flag's
  // effective_diff + the implicit-escalate detector; the reason field above is
  // the gate verdict. When the gate is NOT satisfied the verdict explains the
  // shortfall; the required-count rationale is recoverable from required_approvers.

  return {
    required_approvers,
    distinct_ok: satisfied,
    satisfied,
    reason,
  };
}

/**
 * The stable machine reason for WHY `required_approvers` is what it is (used by
 * the audit payload / pre-flight consumers). Separate from the gate VERDICT
 * (`DualControlDecision.reason`), which reports satisfaction. Pure.
 */
export function requirementReason(
  input: Pick<DualControlInput, "from" | "to" | "addedReadGrants">,
): Extract<
  DualControlReason,
  "escalates_criticality" | "implicit_escalate_clearance" | "routine_change"
> {
  if (
    !isWellFormedCriticality(input.from) ||
    !isWellFormedCriticality(input.to)
  ) {
    // Fail-closed: treat as an escalate-class requirement (more control).
    return "implicit_escalate_clearance";
  }
  if (nonDerivableReadClearance(input.addedReadGrants ?? [])) {
    return "implicit_escalate_clearance";
  }
  if (criticalityDiff(input.from, input.to).escalates) {
    return "escalates_criticality";
  }
  return "routine_change";
}

// ---------------------------------------------------------------------------
// buildConfirmationFlag — assemble the derived in-request record (FR-5, Q-1)
// ---------------------------------------------------------------------------

/**
 * Assemble the DERIVED in-request `ConfirmationFlag` (no persistence). The
 * `approvers` passed in are ALREADY distinct + proposer-excluded (the call-site
 * computes D); `effective_diff` is the serialized `CriticalityDiff`.
 */
export function buildConfirmationFlag(args: {
  changeRef: string;
  diff: CriticalityDiff;
  approvers: string[];
  status: ConfirmationFlagStatus;
}): ConfirmationFlag {
  return {
    change_ref: args.changeRef,
    effective_diff: args.diff,
    approvers: [...args.approvers],
    status: args.status,
  };
}

// ---------------------------------------------------------------------------
// encodeDualControlAuditEvent — thin pure encoder → AuditEventInput (NF-7, Q-1)
// ---------------------------------------------------------------------------

/**
 * Build the `dualcontrol.gate` WORM `AuditEventInput` (T-0031 contract) for the
 * canonical `appendAuditEventInput` writer (NF-7 — NO new audit writer / no
 * parallel path). Mirrors `encodeGrantAuditEvent`. Pure; `nowMs`/`id` supplied
 * by the caller. `via` distinguishes the first confirm from the second.
 */
export function encodeDualControlAuditEvent(args: {
  id: string;
  flag: ConfirmationFlag;
  decision: DualControlDecision;
  changeKind: "grant" | "assignment";
  actor: string;
  proposedBy: string;
  primaryConfirmer: string | null;
  via?: "dual-control" | "dual-control.second-confirm";
  nowMs: number;
}): AuditEventInput {
  const { flag, decision } = args;
  return {
    id: args.id,
    type: "dualcontrol.gate",
    actor: args.actor,
    subject: flag.change_ref,
    scope: null, // the change's scope rides the sibling grant/assignment event
    via: args.via ?? "dual-control",
    proposed_by: args.proposedBy,
    confirmed_by: args.primaryConfirmer,
    payload: {
      change_kind: args.changeKind,
      required_approvers: decision.required_approvers,
      escalates: flag.effective_diff.escalates,
      expanded: flag.effective_diff.expanded,
      approvers: [...flag.approvers],
      status: flag.status,
    },
    occurred_at: args.nowMs,
  };
}
