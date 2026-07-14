/**
 * T-0040: `role_criticality` computation (E4.5) — pure TS, no DB/IO/LLM.
 *
 * The day-1 cost of the signed **D-A = A3** decision: a pure, DERIVED (not
 * stored) function that folds a role's already-fetched `Grant[]` into the three
 * signed criticality axes + a derived `level`. The bits are:
 *
 *  - **axis a (`approve_or_transition`)** ← an EFFECTIVE grant whose
 *    `operation ∈ {"approve","transition"}` (the guarded-transition op-classes).
 *  - **axis b (`external_invoke`)** ← the exact T-0034 gateway predicate
 *    `resourceType === "effect_resource" ∧ operation === "invoke"` on an
 *    EFFECTIVE grant.
 *  - **axis c (`sensitive_read`)** ← `deriveClearance` (T-0033) over the
 *    EFFECTIVE `read` grants, compared against `SENSITIVE_READ_THRESHOLD`.
 *
 * NON-NEGOTIABLE invariants (NF-1..NF-7, mirrored from T-0021/T-0033/T-0034):
 *  - **Rights-derived-only** — every bit derives SOLELY from T-0018 `Grant`
 *    rows + the T-0033 `DataClass` axis. No parallel criticality store, no
 *    second algebra (a sibling check bans the tokens).
 *  - **Pure / static-now** — no `pg`/`fs`/`net`/`http`; DB access only via the
 *    injected `RoleGrantSource` port (Postgres DAO lands in T-0053). `nowMs` is
 *    a parameter — no `Date.now()` in the core, so equal inputs ⇒ equal output.
 *  - **Fail-closed / fail-critical bias** — doubt resolves toward MORE
 *    criticality, never less: a corrupt/unknown `operation` is simply ignored
 *    (it can only ever fail to RAISE a bit, never LOWER one).
 *  - **Derived, not stored** — NO migration, NO new table, NO new column
 *    (spec §6-B); the function is a pure computation over existing rows.
 *
 * `DataClass` / `DATA_CLASS_ORDER` / `deriveClearance` are IMPORTED from
 * `data-classification.ts` (never redeclared); `Grant` / `Operation` /
 * `isEffective` are IMPORTED from `grant-lattice.ts`.
 *
 * Consumer: T-0044 (E4.6 dual-control gate) imports `RoleCriticality` +
 * `criticalityDiff` and keys two-approver on `escalates`; it MUST NOT recompute
 * the bits (single source of truth, FR-7). The record shape + the
 * `criticalityDiff` signature are a FROZEN contract (BLOCKING if changed).
 *
 * Semantic contract: docs/design/T-0040-role-criticality.adr.md §3–§4.
 */

import { type Grant, isEffective } from "./grant-lattice.js";
import {
  type DataClass,
  DATA_CLASS_ORDER,
  deriveClearance,
} from "./data-classification.js";

// ---------------------------------------------------------------------------
// The frozen T-0044 contract (§5 of the spec / §3 of the ADR)
// ---------------------------------------------------------------------------

/**
 * Two-valued criticality level. `routine` ⇔ T-0044's single-scoped-approver
 * path; `critical` ⇔ T-0044's two-distinct-approver path.
 */
export type RoleCriticalityLevel = "routine" | "critical";

/**
 * The frozen criticality record T-0044 consumes (FR-7). The three bits encode
 * the signed D-A=A3 axes; `level` is the single-approver carveout.
 */
export interface RoleCriticality {
  approve_or_transition: boolean; // axis a — effective grant operation ∈ {approve, transition}
  external_invoke: boolean; // axis b — effective effect_resource ∧ invoke grant held
  sensitive_read: boolean; // axis c — effective read clearance rank ≥ rank(SENSITIVE_READ_THRESHOLD)
  level: RoleCriticalityLevel; // "critical" iff any axis true (the single-approver carveout)
}

/**
 * The day-1 sensitivity threshold for axis c. A `read` grant conferring
 * clearance whose rank is `≥` this raises `sensitive_read` (`confidential` or
 * `restricted`); `public`/`internal`/none does not (the threshold carveout,
 * FR-4). Tunable within the closed `DataClass` axis without a spec change
 * (spec §7) — it neither alters scope nor the contract shape.
 */
export const SENSITIVE_READ_THRESHOLD: DataClass = "confidential";

/**
 * Injected port — the Postgres DAO is deferred to T-0053 (mirrors
 * `GrantSource`/`ClassificationSource`/`EffectSource`). `getRoleGrants` returns
 * the role's grant rows (`grant.role_id == roleId ∧ grant.tenant_id == tenantId`)
 * PRE-SCOPED to one tenant; the core adds no cross-tenant edge (FR-1/FR-8).
 */
export interface RoleGrantSource {
  getRoleGrants(tenantId: string, roleId: string): Promise<Grant[]>;
}

/**
 * The T-0044 diff seam (FR-7). `expanded.<bit>` is true iff the bit flips
 * `false→true` from→to; `escalates` is true iff the to-state is `critical` and
 * the from-state is not (≡ any expanded bit). T-0044 keys two-approver on
 * `escalates`; T-0040 owns the diff, T-0044 owns the gate.
 */
export interface CriticalityDiff {
  expanded: {
    approve_or_transition: boolean;
    external_invoke: boolean;
    sensitive_read: boolean;
  };
  escalates: boolean; // routine→critical (≡ any expanded bit)
}

// ---------------------------------------------------------------------------
// Pure level derivation (shared by combineCriticality and any caller)
// ---------------------------------------------------------------------------

/**
 * Derive the `level` from the three bits: `critical` iff ANY axis is true,
 * else `routine` (FR-5). Total, pure — the exact single-approver carveout
 * T-0044 keys its single-vs-two-approver path on.
 */
export function criticalityLevel(c: {
  approve_or_transition: boolean;
  external_invoke: boolean;
  sensitive_read: boolean;
}): RoleCriticalityLevel {
  return c.approve_or_transition || c.external_invoke || c.sensitive_read
    ? "critical"
    : "routine";
}

// ---------------------------------------------------------------------------
// The pure fold — combineCriticality (the atomic unit; no IO)
// ---------------------------------------------------------------------------

/**
 * Fold a role's already-fetched `Grant[]` into a `RoleCriticality` at instant
 * `nowMs`. PURE / deterministic / no IO — the grants are supplied; the port
 * read (if any) happened upstream. Only EFFECTIVE grants count (FR-6): an
 * out-of-window grant confers zero capability.
 *
 * Fail-closed (NF-3, AC-13): a grant whose `operation` is not a genuine
 * `approve`/`transition`/`invoke`/`read` simply fails the literal `.some(...)`
 * /`.filter(...)` match — it can never CLEAR a bit, so an unknown op never
 * lowers criticality (the safe direction for a dual-control trigger is to
 * OVER-, not UNDER-, flag).
 */
export function combineCriticality(
  grants: Grant[],
  nowMs: number,
): RoleCriticality {
  // Ge = effective grants only (FR-6). isEffective is the SINGLE place validity
  // is decided (T-0018) — no second window algebra here.
  const ge = grants.filter((g) => isEffective(g, nowMs));

  // axis a — a guarded-transition op-class held (literal match; an unknown op
  // string never matches, so it never raises NOR clears the bit).
  const approve_or_transition = ge.some(
    (g) => g.operation === "approve" || g.operation === "transition",
  );

  // axis b — the exact T-0034 verifyEffectGrants gateway predicate.
  const external_invoke = ge.some(
    (g) => g.resourceType === "effect_resource" && g.operation === "invoke",
  );

  // axis c — clearance of the effective READ grants vs the threshold. Filtering
  // to operation === "read" before deriveClearance keeps a clearance marker
  // that happens to sit on a NON-read grant from raising the read bit (AC-9).
  const readGrants = ge.filter((g) => g.operation === "read");
  const clearance = deriveClearance(readGrants, nowMs);
  const sensitive_read =
    clearance !== null &&
    DATA_CLASS_ORDER.indexOf(clearance) >=
      DATA_CLASS_ORDER.indexOf(SENSITIVE_READ_THRESHOLD);

  const level = criticalityLevel({
    approve_or_transition,
    external_invoke,
    sensitive_read,
  });

  return { approve_or_transition, external_invoke, sensitive_read, level };
}

// ---------------------------------------------------------------------------
// The only async / IO-bearing seam — fetch via the port, then combine
// ---------------------------------------------------------------------------

/**
 * Convenience: fetch the role's grants via the injected `RoleGrantSource`
 * port, then `combineCriticality`. This is the ONLY async / IO-bearing
 * function; `combineCriticality` / `criticalityLevel` / `criticalityDiff` are
 * sync, pure, total. Determinism (NF-7): with a deterministic port + identical
 * `(tenantId, roleId, nowMs)`, the output is deep-equal across calls.
 */
export async function roleCriticality(
  source: RoleGrantSource,
  tenantId: string,
  roleId: string,
  nowMs: number,
): Promise<RoleCriticality> {
  const grants = await source.getRoleGrants(tenantId, roleId);
  return combineCriticality(grants, nowMs);
}

// ---------------------------------------------------------------------------
// The T-0044 diff seam — structural expansion of from→to
// ---------------------------------------------------------------------------

/**
 * Structural diff of two `RoleCriticality` records (FR-7, AC-12). T-0044
 * consumes this to decide two-vs-one approver: an `expanded` bit fires iff the
 * bit goes `false→true`; `escalates` fires iff the to-state is `critical` and
 * the from-state is not. A `true→false` NARROWING or any cosmetic same-state
 * (`false→false`, `true→true`) does NOT escalate. Pure / total.
 */
export function criticalityDiff(
  from: RoleCriticality,
  to: RoleCriticality,
): CriticalityDiff {
  const expanded = {
    approve_or_transition:
      to.approve_or_transition === true && from.approve_or_transition === false,
    external_invoke:
      to.external_invoke === true && from.external_invoke === false,
    sensitive_read: to.sensitive_read === true && from.sensitive_read === false,
  };
  const escalates = to.level === "critical" && from.level !== "critical";
  return { expanded, escalates };
}
