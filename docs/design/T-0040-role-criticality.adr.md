# ADR · T-0040 — `role_criticality` computation (E4.5)

**Status:** ready
**Phase:** DESIGN
**Date:** 2026-06-11
**Task:** E4.5 — pure, derived `roleCriticality(role) → {approve_or_transition, external_invoke, sensitive_read, level}` over the role's grant rows + the data-classification axis; the day-1 cost of the signed **D-A = A3** decision. Consumer: T-0044 (E4.6 dual-control gate).
**Spec:** `docs/specs/T-0040-role-criticality.spec.md` (18 AC, `status: ready`) · contract `docs/specs/T-0040.spec.contract.json`.
**Base:** dev `99d6612`; worktree `task/T-0040-role-criticality`.

---

## 1. Decision (the mechanism, one paragraph)

Build **one new pure module** `src/core/role-criticality.ts` — zero IO, zero migration, zero new authority
store. It owns the frozen `RoleCriticality` record (§5 of the spec, the T-0044 seam) and a small family of
**total, deterministic** functions that fold a role's already-fetched `Grant[]` into the three signed D-A=A3
bits and a derived `level`. The three bits are computed **solely** by re-using the merged foundation
predicates — there is no second algebra:

- **axis a (`approve_or_transition`)** ← `grant-lattice.ts` `Operation` membership `∈ {"approve","transition"}`
  on an **effective** grant (`isEffective(grant, nowMs)`).
- **axis b (`external_invoke`)** ← the exact T-0034 gateway predicate `resourceType === "effect_resource" ∧
  operation === "invoke"` on an **effective** grant.
- **axis c (`sensitive_read`)** ← `deriveClearance(effectiveReadGrants, nowMs)` from `data-classification.ts`
  (T-0033), compared against a single named threshold `SENSITIVE_READ_THRESHOLD: DataClass = "confidential"`
  whose rank is read off the frozen `DATA_CLASS_ORDER`.

`DataClass` / `deriveClearance` are **imported** from `data-classification.ts` (never redeclared); `Grant` /
`Operation` / `ResourceType` / `isEffective` are **imported** from `grant-lattice.ts`. Database access is
deferred behind an **injected port** `RoleGrantSource.getRoleGrants(tenantId, roleId): Promise<Grant[]>` —
exactly mirroring T-0021's `GrantSource`, T-0033's `ClassificationSource`, T-0034's `EffectSource`; the
Postgres DAO lands in T-0053. The module emits **no migration**, **no new table**, **no new column**:
`role_criticality` is a **pure computation over existing rows** (`§6-B` derived-not-stored decision). A new
structural fitness gate `ci/checks/role-criticality-isolation.sh` (banned-token + no-IO-import floor + export
seam) is wired into `npm run fitness`; the frozen foundation files and the migration set are byte-untouched.

This is the **minimal mechanism** the task admits: a thin pure fold over rows the resolver already owns,
with the gate/diff-application/audit deliberately left to the consumer (T-0044). Tonkoye yadro, logika na
granitsakh (CONCEPT §5).

## 2. Rejected alternatives

| Option | Why not |
|---|---|
| **Materialize `role_criticality` as a `grant`/`role` column or a new `role_criticality` table (+ migration 030)** | Duplicates authority state that already lives in `grant` + `data_classification`, violating the rights-derived-only invariant the resolver enforces (NF-2). Forces a write-path re-derivation hook on every grant/classification change — strictly worse than recompute-on-read. Spec `§6-B` rules this out; day-1 is the pure function. Materialization is a **T-0053** concern only if perf ever demands it. |
| **A second "criticality" authority algebra (a `critFlags`/`criticalityAcl`/field-visibility token computed independently of grants)** | A parallel authority subsystem that drifts from the `grant` table — the precise anti-pattern `data-classification-isolation.sh` / `effect-resource-isolation.sh` ban. Every bit MUST derive from `Grant` rows + `DataClass` only (NF-2). |
| **Recompute the three bits independently inside T-0044** | Splits the source of truth: T-0044's gate and T-0040's computation could diverge silently (a classic two-implementations bug). FR-7 fixes the seam: T-0040 owns the computation + the record + `criticalityDiff`; T-0044 consumes them and **must not** recompute. |
| **Inline the fold into `grant-resolver.ts` (no separate module)** | Couples the resolver to the criticality contract + the T-0044 diff helper, bloating its responsibility boundary and forcing an edit to a near-frozen hot file. A separate pure module keeps the seam self-contained and re-importable by T-0044 without pulling resolver internals. (Same reasoning T-0034 used for a separate `effect-resource.ts`.) |
| **Let the core call `Date.now()` / read clearance via a field-name lookup** | Breaks purity/determinism (NF-1/NF-7): `nowMs` is a parameter so equal inputs ⇒ equal output. Clearance rides on the **existing** opaque `grant.constraint` marker via `deriveClearance` (T-0033's constraint-first reader) — no field-ACL store, no `Grant` schema change. |
| **`deriveClearance` over ALL grants (not just `read` grants)** | The D-A axis (c) is specifically *read* PII/financial data above a threshold. Filtering `Ge` to `operation === "read"` before `deriveClearance` keeps a clearance marker that happens to sit on a non-read grant from raising the **read**-sensitivity bit (AC-9). |

## 3. Object model / contract (the frozen T-0044 seam)

All types/signatures below are the **BLOCKING** contract `coder` and `tester` read as the source of truth.
Changing any shape after sign-off is a contract break (FR-7).

```ts
// src/core/role-criticality.ts
import {
  Grant,
  Operation,            // type-only — used for the closed-set fail-closed reasoning
  isEffective,
} from "./grant-lattice";
import { DataClass, DATA_CLASS_ORDER, deriveClearance } from "./data-classification";

export type RoleCriticalityLevel = "routine" | "critical";

export interface RoleCriticality {
  approve_or_transition: boolean; // axis a — effective grant with operation ∈ {approve, transition}
  external_invoke: boolean;       // axis b — effective resourceType==="effect_resource" ∧ operation==="invoke"
  sensitive_read: boolean;        // axis c — deriveClearance(effective read grants) rank ≥ rank(threshold)
  level: RoleCriticalityLevel;    // "critical" iff any axis true (the single-approver carveout)
}

// day-1 sensitivity threshold; tunable within the closed DataClass axis (FR-4, spec §7)
export const SENSITIVE_READ_THRESHOLD: DataClass = "confidential";

// injected port — Postgres DAO deferred to T-0053 (mirrors GrantSource/ClassificationSource/EffectSource)
export interface RoleGrantSource {
  getRoleGrants(tenantId: string, roleId: string): Promise<Grant[]>;
}

// PURE compute over an already-fetched grant set (no IO). The atomic unit.
export function combineCriticality(grants: Grant[], nowMs: number): RoleCriticality;

// convenience: fetch via the injected port, then combine (the only async, IO-bearing seam)
export function roleCriticality(
  source: RoleGrantSource, tenantId: string, roleId: string, nowMs: number,
): Promise<RoleCriticality>;

// pure level derivation from the three bits (shared by combineCriticality and any caller)
export function criticalityLevel(
  c: { approve_or_transition: boolean; external_invoke: boolean; sensitive_read: boolean },
): RoleCriticalityLevel;

// the T-0044 diff seam — structural expansion of from→to
export interface CriticalityDiff {
  expanded: { approve_or_transition: boolean; external_invoke: boolean; sensitive_read: boolean };
  escalates: boolean; // routine→critical (≡ any expanded bit)
}
export function criticalityDiff(from: RoleCriticality, to: RoleCriticality): CriticalityDiff;
```

**Entity summary (record fields):**

| Entity | Field | Type |
|---|---|---|
| `RoleCriticality` | `approve_or_transition` | `boolean` |
| | `external_invoke` | `boolean` |
| | `sensitive_read` | `boolean` |
| | `level` | `"routine" \| "critical"` |
| `CriticalityDiff` | `expanded` | `{ approve_or_transition, external_invoke, sensitive_read: boolean }` |
| | `escalates` | `boolean` (routine→critical) |
| `RoleGrantSource` (port) | `getRoleGrants` | `(tenantId: string, roleId: string) => Promise<Grant[]>` |

## 4. Computation semantics (the fail-closed decision table)

For a role's grant set `G` at instant `nowMs`, let `Ge = G.filter(g => isEffective(g, nowMs))` (FR-6).

1. **`approve_or_transition`** = `Ge.some(g => g.operation === "approve" || g.operation === "transition")`.
   *Fail-closed (NF-3, AC-13):* a grant whose `operation` is **not** in the closed `Operation` set is never
   used to *clear* the bit — it is simply ignored for all three axes (it can only ever fail to *raise* a bit,
   never *lower* one). The doubt direction is toward MORE criticality. Concretely: `.some()` over the literal
   match string can only return `true` for a genuine approve/transition; an unknown op contributes neither a
   true nor a clearing.
2. **`external_invoke`** = `Ge.some(g => g.resourceType === "effect_resource" && g.operation === "invoke")` —
   byte-identical to the T-0034 `verifyEffectGrants` gateway predicate (FR-3). A non-effect `invoke` (AC-5) or
   an `effect_resource` non-`invoke` (AC-6) does **not** set the bit.
3. **`sensitive_read`**: `const R = Ge.filter(g => g.operation === "read");`
   `const cl = deriveClearance(R, nowMs);`
   bit = `cl !== null && DATA_CLASS_ORDER.indexOf(cl) >= DATA_CLASS_ORDER.indexOf(SENSITIVE_READ_THRESHOLD)`.
   `deriveClearance` reads the clearance marker **constraint-first** (then `resourceFacet` fallback) off the
   grant's existing opaque surface — no `Grant` schema change, no field-ACL store. A `read` grant with no
   marker contributes `null` (does not raise the bit, AC-8); `confidential`/`restricted` raises it (AC-7);
   `public`/`internal` does not (the threshold carveout). Re-filtering to effective inside `deriveClearance`
   via the passed `nowMs` is redundant-but-harmless (`R` is already effective) — it costs nothing and keeps
   the call self-evidently effective-only.
4. **`level`** = `criticalityLevel(bits)` = `(a || b || c) ? "critical" : "routine"` (FR-5, AC-10). `routine`
   ⇔ T-0044 single-scoped-approver path; `critical` ⇔ T-0044 two-distinct-approver path.
5. **`criticalityDiff(from, to)`** (FR-7, AC-12):
   `expanded.<bit> = to.<bit> === true && from.<bit> === false`;
   `escalates = to.level === "critical" && from.level !== "critical"` (equivalently: any `expanded` bit).
   A `true→false` *narrowing* or any cosmetic same-state (`false→false`, `true→true`) does **not** escalate.

**Determinism (NF-7):** `combineCriticality(G, nowMs)` and `roleCriticality(src, t, r, nowMs)` called twice
with identical inputs (and a deterministic port) yield deep-equal output — no `Date.now`, no IO outside the
injected port. `roleCriticality` is the **only** async/IO-bearing function; `combineCriticality` /
`criticalityLevel` / `criticalityDiff` are sync, pure, total.

## 5. Where the module lives & its ports

- **Module:** `src/core/role-criticality.ts` — a new sibling of `grant-lattice.ts`, `data-classification.ts`,
  `effect-resource.ts`. Pure: imports only those two foundation modules (+ TS stdlib); **no** `pg`/`fs`/`net`/
  `http`.
- **Port in:** `RoleGrantSource.getRoleGrants(tenantId, roleId): Promise<Grant[]>` — grants arrive
  **pre-scoped to one tenant** (the port owns the JOIN `grant.role_id = role.id ∧ grant.tenant_id = :t`,
  T-0053 RLS-scopes it). The core adds **no** cross-tenant edge and reads **no** global store (FR-8).
- **Port out / consumer:** T-0044 imports `RoleCriticality`, `RoleCriticalityLevel`, `RoleGrantSource`,
  `roleCriticality`, `combineCriticality`, `criticalityLevel`, `criticalityDiff`, `SENSITIVE_READ_THRESHOLD`
  with **no** re-declaration or cast (FR-9, AC-18). T-0044 builds the gate by diffing two `RoleCriticality`
  records via `criticalityDiff` and keying two-approver on `escalates`; it **must not** recompute the bits
  (single source of truth, FR-7).

**Tenant isolation (FR-8 / NF-6):** because nothing is stored, there is **no new tenant table** → the
cross-tenant fitness set and `ci/checks/known_tenant_tables.txt` are byte-unchanged. The function's only
tenant boundary is the port argument; the JOIN's RLS lives in T-0053.

## 6. Fitness functions (architecture as CI)

Every breakable boundary below is an **executable** gate wired into `npm run fitness` (and thus `npm run ci`).
The new script `ci/checks/role-criticality-isolation.sh` mirrors `data-classification-isolation.sh` /
`effect-resource-isolation.sh` exactly (grep/boundary analysis — no runtime, no DB).

| ID | Rule | CI check |
|---|---|---|
| **FF-RC1 (no second authority store)** | `role-criticality.ts` contains no parallel-authority token (`_acl`, `criticalityRights`, `critFlags`, `criticalityAcl`, `field_visibility`, `fieldVisibility`) in non-comment code. Every bit derives from `Grant` rows + `DataClass` only (NF-2). | `ci/checks/role-criticality-isolation.sh` (banned-token grep, comment lines excluded) — wired into `npm run fitness`; AC-15. |
| **FF-RC2 (purity / no IO)** | `role-criticality.ts` imports no `pg`/`fs`/`net`/`http` (DB only via the injected `RoleGrantSource` port). | `role-criticality-isolation.sh` forbidden-import grep; AC-15. NF-1. |
| **FF-RC3 (no `Date.now` in core)** | `role-criticality.ts` contains no `Date.now(` / `new Date(` — `nowMs` is a parameter (determinism). | `role-criticality-isolation.sh` grep; NF-7/FR-6. |
| **FF-RC4 (T-0044 export seam)** | The module exports exactly `RoleCriticality`, `RoleCriticalityLevel`, `RoleGrantSource`, `roleCriticality`, `combineCriticality`, `criticalityLevel`, `criticalityDiff`, `SENSITIVE_READ_THRESHOLD`; `DataClass`/`deriveClearance` are imported from `data-classification.ts` (not redeclared). | `role-criticality-isolation.sh` asserts each `export` symbol present + asserts an `import ... from "./data-classification"` line and **no** local `type DataClass` redeclaration; AC-18/FR-9. |
| **FF-RC5 (frozen foundation, byte-level)** | The commit does not edit `grant-lattice.ts`, `data-classification.ts`, `effect-resource.ts`, `grant-resolver.ts`, `object-handle.ts`, or any `migrations/*.sql`. | `role-criticality-isolation.sh` runs `git diff --name-only <base>...HEAD` and fails if any frozen path appears; plus `tsc --noEmit` in `npm run ci`. AC-16/NF-5. |
| **FF-RC6 (no migration / tenant-table set unchanged)** | No new `migrations/*.sql` added; `ci/checks/known_tenant_tables.txt` byte-unchanged; the cross-tenant fitness set unchanged (derived, not stored). | `role-criticality-isolation.sh` asserts `git diff --name-only` adds no `migrations/*.sql` and no change to `known_tenant_tables.txt`; the existing `cross-tenant-fitness.sh` stays green untouched. AC-17/NF-6. |
| **FF-RC7 (bit-derivation + carveout + diff, behavioural)** | The 14 behavioural ACs (a/b/c derivation, threshold carveout, read-op-only, level, effective-window, fail-closed unknown op, diff expansion, determinism) hold. | `src/__tests__/role-criticality.test.ts` (vitest, `npm test`) — one assertion per AC-1..AC-14. |

**Wiring:** append `&& bash ci/checks/role-criticality-isolation.sh` to the `fitness` script in `package.json`
(non-frozen file). The CI job already runs `npm run ci` → `npm run fitness`, so the gate is blocking on merge.

## 7. Traceability (AC → design site)

| AC | Covered by |
|---|---|
| AC-1 approve grant ⇒ bit | §4 rule 1; FF-RC7 / `role-criticality.test.ts` |
| AC-2 transition grant ⇒ bit | §4 rule 1; FF-RC7 |
| AC-3 only read/create/update/delete ⇒ bit false | §4 rule 1; FF-RC7 |
| AC-4 effect_resource∧invoke ⇒ bit | §4 rule 2; FF-RC7 |
| AC-5 non-effect invoke ⇒ false | §4 rule 2; FF-RC7 |
| AC-6 effect_resource non-invoke ⇒ false | §4 rule 2; FF-RC7 |
| AC-7 read clearance confidential/restricted ⇒ bit | §4 rule 3 (`deriveClearance` + threshold); FF-RC7 |
| AC-8 read clearance public/internal/none ⇒ false | §4 rule 3 (threshold carveout); FF-RC7 |
| AC-9 confidential clearance on non-read op ⇒ false | §4 rule 3 (`R` filter to `operation==="read"`); FF-RC7 |
| AC-10 level critical iff any bit | §4 rule 4 / `criticalityLevel`; FF-RC7 |
| AC-11 effective-window honored | §4 `Ge` filter (`isEffective`) + `deriveClearance(nowMs)`; FF-RC7 |
| AC-12 criticalityDiff expansion/escalates | §4 rule 5 / `criticalityDiff`; FF-RC7 |
| AC-13 fail-closed unknown operation | §4 rule 1 fail-closed note (NF-3); FF-RC7 |
| AC-14 determinism/purity | §4 determinism note; FF-RC7 + FF-RC2/FF-RC3 |
| AC-15 isolation floor (no parallel store / no IO import) | FF-RC1 + FF-RC2 (`role-criticality-isolation.sh`) |
| AC-16 frozen foundation + `tsc --noEmit` | FF-RC5 |
| AC-17 no migration / tenant-table set unchanged | FF-RC6 |
| AC-18 T-0044 export seam, `DataClass`/`deriveClearance` imported | FF-RC4 |

## 8. Runtime / deploy target

**Local (library code).** `role-criticality.ts` is in-process pure TS, no runtime of its own; it executes
wherever the resolver/T-0044 gate runs (the Choros app process). **No external resource, no founder gate
(GT-4) needed** — no server, no DB-hosting, no migration. The Postgres `RoleGrantSource` DAO is deferred to
T-0053 (which carries its own runtime/deploy concerns).

## 9. Escalation

**None.** All product forks are pre-decided by founder-signed sources: D-A=A3 (hypothesis §7), the three
axes, the "above a threshold" wording, the derived-not-stored decision (§6-B), and the T-0040/T-0044 split.
The one tunable default — `SENSITIVE_READ_THRESHOLD = "confidential"` — is a constant the architect may set
within the closed `DataClass` axis without a spec change (spec §7); it neither alters scope nor the contract
shape. This is low-leverage, single-vendor library work; no product loop / cross-vendor sparring required.
