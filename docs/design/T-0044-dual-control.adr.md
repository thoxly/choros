# ADR T-0044 — Dual-control gate keyed to criticality (E4.6, D-A = A3)

- **Task:** T-0044 (E4.6) · product Choros
- **Phase:** DESIGN
- **Branch:** `task/T-0044-dual-control` (base dev `91f991e`)
- **Status:** `ready` (the 3 SPEC-blocking questions are resolved by an **orchestrator
  ruling** under the ratified `founder-autonomy-impl` frame: direction D-A=A3 is signed,
  the *implementation shape* of Q-1..Q-3 is autonomous; the ruling is applied as a given
  below and recorded in friction ledger `FE-2026-W24-0044`).
- **Consumes (frozen, byte-untouched):** `src/core/role-criticality.ts` (T-0040) —
  `RoleCriticality`, `CriticalityDiff`, `combineCriticality`, `criticalityDiff`,
  `criticalityLevel`, `SENSITIVE_READ_THRESHOLD`. T-0044 **MUST NOT** recompute the bits.
- **Consumes (frozen):** `src/core/data-classification.ts` — `DataClass`, `isDataClass`
  (read-only, for the Q-2 clearance-derivability probe); `src/core/grant-lattice.ts` —
  `Grant`, `isEffective`; `src/core/audit-grant-encoder.ts` — `AuditEventInput` (T-0031 seam).
- **Integration seam (edited):** `src/http/grants.ts` (T-0030/T-0022 write-paths) — the
  gate is consulted **before** a confirmed row is written.

---

## 1. Orchestrator ruling applied (Q-1 / Q-2 / Q-3)

> Recorded as **orchestrator ruling** under `founder-autonomy-impl`: founder owns DIRECTION
> (D-A=A3 signed) + red-lines; the *implementation shape* below is autonomous. The three
> SPEC-blocking questions are answered here as a given, not re-escalated.

### Q-1 — `confirmation_flag` is **DERIVED + a WORM audit event** (no new table)

`confirmation_flag` is an **in-request decision object**, never a persisted control-plane
table. Its rationale — the serialized `CriticalityDiff`, the distinct `approvers[]`, the
`change_ref`, and the `status` — is persisted as a **WORM `audit_event`** of canonical
`type = "dualcontrol.gate"`, appended through the **existing** `appendAuditEventInput`
path in `grants.ts` (the same SHA-256-chained writer T-0030/T-0031 already use). This
mirrors the **T-0040 §6-B derived-not-stored precedent** exactly: zero migration, zero new
table, zero new column, `known_tenant_tables.txt` byte-unchanged.

> Encoder path: `AuditEventInput` (T-0031, re-exported from `audit-grant-encoder.ts`) is a
> **generic** seam — `{id,type,actor,subject,scope,via,proposed_by,confirmed_by,payload,occurred_at}`.
> T-0044 builds a `dualcontrol.gate` `AuditEventInput` directly (a thin pure encoder in the
> new T-0044 module, mirroring `encodeGrantAuditEvent`) and writes it via the **canonical**
> `appendAuditEventInput`. **No new audit writer, no parallel audit path (NF-7).** T-0068 is
> in flight and its writer is NOT on this base — T-0044 uses **only** the T-0031 `AuditEventInput`
> contract + the `grants.ts` `appendAuditEventInput` function present on dev `91f991e`.

### Q-2 — corrupt / non-derivable clearance ⇒ **implicit escalate (fail-closed)**

A newly-added **read** grant whose `clearance` marker is **present but not a derivable
`DataClass`** (garbage token) is treated as an **implicit escalate** — the gate forces
`required_approvers = 2` **before** consulting `criticalityDiff`. This closes the T-0040
**R-1 under-flag** breach-path (axis c inherits T-0033 `deriveClearance` quiet-null → a
garbage clearance silently resolves to `sensitive_read = false`). T-0044 **cannot** fix this
by editing frozen T-0040/T-0033; instead it adds a **detector on its own side**: a pure
helper `nonDerivableReadClearance(addedReadGrants)` that flags a read grant carrying a
clearance *key* whose *value* fails `isDataClass`. This is the exact preventive-brake case
D-A=A3 was chosen to close, and aligns with NF-2 ("doubt → MORE criticality"). The detector
reuses the **frozen** `isDataClass` from `data-classification.ts` (it does NOT re-derive the
axis; it only asks "is this token a valid `DataClass`?").

> Note on the **absence** of a marker vs a **corrupt** marker: a read grant with *no*
> clearance key at all is NOT an escalate (a public/internal read confers no sensitivity —
> spec-conformant to T-0040). Only a *present-but-unparseable* clearance token escalates.

### Q-3 — enforcement at the **existing single-INSERT write-path** (two-phase = downstream)

The gate attaches at the **existing** `POST /api/grants` and `POST /api/role-assignments`
write-paths (no new endpoint, no new table, no migration). The two approvers arrive in **one
request** as an `approvers: string[]` body field; the gate is consulted **before** the
confirmed row is INSERTed. A change whose gate is unsatisfied is rejected
(`HTTP 4xx DUAL_CONTROL_UNSATISFIED`) and **no confirmed row is written**.

The existing single-confirmer columns carry the day-1 record without DDL:
`proposed_by` = the proposer; `confirmed_by` = approver₁ (the primary confirmer). The full
distinct `approvers[]` set (incl. approver₂) is captured in the `dualcontrol.gate`
`audit_event.payload`. **The durable multi-request "half-confirmed" state** (propose now,
a second approver confirms in a *later* request) **is the downstream human-approval workflow**
— explicitly out of scope per spec §5 / §6, and would be the task that, if ever needed, adds
migration 031. **Day-1 needs no migration** (`ddl_needed: none`), satisfying the
integration-honesty seam (D-056): the gate's core decision function is exercised end-to-end by
a **real** enforced write-path call, not left as dead code.

---

## 2. Decision (the mechanism)

Build **one new pure module** `src/core/dual-control.ts` — zero IO, zero migration, zero new
authority store — that owns:

1. **`dualControlDecision(input) → DualControlDecision`** — the pure, deterministic gate
   decision. `required_approvers` is `2` iff `criticalityDiff(from,to).escalates === true`
   **OR** the Q-2 implicit-escalate fires (a non-derivable clearance on an added read grant);
   else `1`. `satisfied` enforces the distinctness invariant (FR-3). `reason` is a stable
   machine string. No `pg`/`fs`/`net`/`http`, no `Date.now()` (time, if ever needed, is a
   parameter). Equal inputs ⇒ deep-equal output.
2. **`nonDerivableReadClearance(addedReadGrants) → boolean`** — the Q-2 detector (pure,
   reuses frozen `isDataClass`).
3. **`buildConfirmationFlag(...) → ConfirmationFlag`** — assembles the derived in-request
   record `{change_ref, effective_diff, approvers[], status}` (Q-1; no persistence).
4. **`encodeDualControlAuditEvent(flag, decision, actor, nowMs) → AuditEventInput`** — a thin
   pure encoder (mirrors `encodeGrantAuditEvent`) producing a `dualcontrol.gate`
   `AuditEventInput` for the **canonical** `appendAuditEventInput` writer.

The **integration seam** edits `src/http/grants.ts`: at `POST /api/grants` and
`POST /api/role-assignments`, after `validateAdminDelegation` and **before** the INSERT,
compute `from`/`to` `RoleCriticality` via `combineCriticality` over the role's effective
grants before/after the proposed change, call `dualControlDecision`, reject with
`DUAL_CONTROL_UNSATISFIED` if unsatisfied, and on success append the `dualcontrol.gate` WORM
event **in the same transaction** as the INSERT + the existing grant/assignment audit event.

A new structural fitness gate `ci/checks/dual-control-isolation.sh` (banned-token + no-IO +
no-Date.now + export-seam + single-source-of-criticality + no-SoD + frozen-foundation +
no-migration + known_tenant_tables-unchanged) is appended to `npm run fitness`.

### 2.1 The `escalates` subtlety — recorded, and why the Q-2 detector matters

T-0040 defines `criticalityDiff(from,to).escalates = to.level === "critical" && from.level !==
"critical"` — i.e. it fires **only** on the `routine → critical` transition. It does **NOT**
fire when a role that is **already** `critical` (e.g. axis a held) gains a **second** axis
(axis b newly true) — because `from.level` is already `critical`. Per FR-2 this is the
**frozen** contract and T-0044 keys two-approver **only** on `escalates` (it must not
recompute). T-0044 records this as a known boundary: *adding a new critical axis to an
already-critical role is, by the T-0040 contract, NOT a fresh escalation* (the role already
required dual-control to reach `critical`). The per-axis `expanded` bits remain available in
the serialized `effective_diff` for the audit record (AC-12) and for any downstream
finer-grained policy, but the **gate trigger** is `escalates`, as the spec mandates. This is
deliberately *not* fixed here (would require editing frozen T-0040); it is flagged as friction
`FE-2026-W24-0044-A` for a possible follow-up that distinguishes "any axis newly raised" from
"routine→critical". The Q-2 implicit-escalate is **independent** of this and fires regardless
of `from.level`, since a garbage clearance is a fail-closed signal, not a level transition.

---

## 3. Object model / contracts

### 3.1 `DualControlInput` (gate input — pure)

```ts
export interface DualControlInput {
  from: RoleCriticality;          // compiled BEFORE the proposed change (combineCriticality)
  to: RoleCriticality;            // compiled AFTER the proposed change (combineCriticality)
  proposedBy: string;             // the proposer principal id
  approvers: string[];            // supplied approver principal ids (may contain dups/proposer)
  // Q-2 fail-closed input: the READ grants the change ADDS (for the clearance-derivability probe).
  // Empty/absent ⇒ no implicit escalate from this axis. Optional to keep non-grant call-sites simple.
  addedReadGrants?: Grant[];
}
```

### 3.2 `DualControlDecision` (gate output — FR-1)

```ts
export interface DualControlDecision {
  required_approvers: 1 | 2;
  distinct_ok: boolean;   // the supplied approver set satisfies the distinctness invariant
  satisfied: boolean;     // distinct_ok AND enough distinct approvers for required_approvers
  reason: DualControlReason; // stable machine string (see §3.3)
}
```

### 3.3 `DualControlReason` (stable machine strings — deterministic)

```ts
export type DualControlReason =
  | "escalates_criticality"          // required 2: criticalityDiff.escalates === true
  | "implicit_escalate_clearance"    // required 2: Q-2 non-derivable clearance on an added read grant
  | "routine_change"                 // required 1: no escalation
  | "satisfied"                      // satisfied === true (gate passes)
  | "insufficient_distinct_approvers"// satisfied === false: not enough distinct ≠ proposer
  | "malformed_input";               // fail-closed (NF-2): malformed → denies (never a satisfiable single-approver result)
```

### 3.4 `ConfirmationFlag` (DERIVED in-request record — Q-1, FR-5)

```ts
export type ConfirmationFlagStatus = "pending" | "satisfied" | "rejected";

export interface ConfirmationFlag {
  change_ref: string;            // target change id (grant id / assignment id)
  effective_diff: CriticalityDiff; // serialized {expanded{a,b,c}, escalates} — from T-0040
  approvers: string[];           // the recorded DISTINCT approver set (proposer excluded)
  status: ConfirmationFlagStatus;
}
```

NO table backs `ConfirmationFlag`. It is constructed per-request and serialized into the
`dualcontrol.gate` `audit_event.payload`.

### 3.5 `dualcontrol.gate` audit event (WORM — Q-1, NF-7)

`encodeDualControlAuditEvent` produces an `AuditEventInput` (T-0031 contract):

| field          | value                                                              |
|----------------|--------------------------------------------------------------------|
| `type`         | `"dualcontrol.gate"`                                               |
| `actor`        | the requesting actor id                                            |
| `subject`      | the target `change_ref` (grant id / assignment id)                |
| `scope`        | `null` (the change's scope rides the sibling grant/assignment event) |
| `via`          | `"dual-control"`                                                   |
| `proposed_by`  | `flag` proposer                                                    |
| `confirmed_by` | approver₁ (primary confirmer) or `null`                           |
| `payload`      | `{ change_kind, required_approvers, escalates, expanded:{a,b,c}, approvers:[…], status }` |
| `occurred_at`  | `nowMs` (caller-supplied)                                          |

Written via the **canonical** `appendAuditEventInput(client, tenantId, input)` already in
`grants.ts` — same transaction as the INSERT (NF-7).

### 3.6 Function contracts

```ts
// FR-1/2/3/14 — the pure gate decision.
export function dualControlDecision(input: DualControlInput): DualControlDecision;

// Q-2 — pure detector: true iff any added read grant carries a clearance KEY whose VALUE
// is present but not a derivable DataClass (reuses frozen isDataClass).
export function nonDerivableReadClearance(addedReadGrants: Grant[]): boolean;

// FR-5 — assemble the derived in-request record (no persistence).
export function buildConfirmationFlag(args: {
  changeRef: string;
  diff: CriticalityDiff;
  approvers: string[];         // already distinct, proposer-excluded
  status: ConfirmationFlagStatus;
}): ConfirmationFlag;

// Q-1/NF-7 — pure encoder → AuditEventInput for the canonical appendAuditEventInput.
export function encodeDualControlAuditEvent(args: {
  flag: ConfirmationFlag;
  decision: DualControlDecision;
  changeKind: "grant" | "assignment";
  actor: string;
  proposedBy: string;
  primaryConfirmer: string | null;
  nowMs: number;
}): AuditEventInput;
```

### 3.7 Distinctness invariant (FR-3, AC-3..7)

Let `D = unique(approvers) \ {proposedBy}` (dedupe, drop proposer).
- `required_approvers === 2` ⇒ `satisfied === (|D| ≥ 2)`.
- `required_approvers === 1` ⇒ `satisfied === (|D| ≥ 1)`.
- `distinct_ok` mirrors `satisfied` for the relevant arm; the recorded `flag.approvers` is `D`.

### 3.8 Integration call-site (pseudocode, in `grants.ts` write-paths)

```text
// after validateAdminDelegation, before INSERT, inside withTenantTx:
fromCrit = combineCriticality(currentEffectiveRoleGrants, nowMs)
toCrit   = combineCriticality(currentEffectiveRoleGrants + proposedGrant, nowMs)
diff     = criticalityDiff(fromCrit, toCrit)
addedReadGrants = proposedGrant.operation === "read" ? [proposedGrant] : []
decision = dualControlDecision({ from: fromCrit, to: toCrit, proposedBy, approvers, addedReadGrants })
if (!decision.satisfied) throw HttpError(409|422, "DUAL_CONTROL_UNSATISFIED", decision.reason)  // no confirmed row written
flag = buildConfirmationFlag({ changeRef: newId, diff, approvers: D, status: "satisfied" })
INSERT ... (confirmed_by = approver1)
appendAuditEventInput(client, tenantId, encodeDualControlAuditEvent({...flag, decision, ...}))   // same tx, WORM
writeGrantAuditEvent(...)  // existing grant/assignment event, same tx
```

> The day-1 enforced consumer is `POST /api/grants` (grant change). `POST /api/role-assignments`
> gets the same guard call (FR-7). The `from`/`to` grant fold uses the role's currently-effective
> grants; on dev these are read via the existing write-path query (T-0053 binds the live DAO).

---

## 4. Fitness functions (CI-enforced)

| id      | rule                                                                                       | ci_check |
|---------|--------------------------------------------------------------------------------------------|----------|
| FF-DC1  | `dual-control.ts` imports no `pg`/`fs`/`net`/`http` (pure core, NF-1).                      | `ci/checks/dual-control-isolation.sh` grep forbidden imports |
| FF-DC2  | `dual-control.ts` uses no `Date.now()`/`new Date()` (determinism, NF-3).                    | `ci/checks/dual-control-isolation.sh` grep (non-comment) |
| FF-DC3  | Single source of criticality: `dual-control.ts` IMPORTS `criticalityDiff`/`combineCriticality`/`RoleCriticality`/`CriticalityDiff` from `./role-criticality(.js)` and does NOT redeclare the three axis names as derivations (no `approve_or_transition =` / `external_invoke =` / `sensitive_read =` assignment in non-comment code) — FR-8, AC-13. | `ci/checks/dual-control-isolation.sh` grep import + ban re-derivation |
| FF-DC4  | Export seam present: `dualControlDecision`, `nonDerivableReadClearance`, `buildConfirmationFlag`, `encodeDualControlAuditEvent`, and the types `DualControlInput`/`DualControlDecision`/`ConfirmationFlag`. | `ci/checks/dual-control-isolation.sh` grep exports |
| FF-DC5  | SoD boundary (AC-18): `dual-control.ts` and the new gate call-site do NOT reference `sod_constraint` / `sodEvaluate` / the T-0032 evaluator. | `ci/checks/dual-control-isolation.sh` grep ban `sod` tokens |
| FF-DC6  | No new authority store: no parallel-authority token (`_acl`/`dualControlAcl`/`approverRights`/`gateFlags`) in non-comment code. | `ci/checks/dual-control-isolation.sh` grep ban tokens |
| FF-DC7  | Derived-not-stored (Q-1, NF-6, AC-16): no NEW `migrations/*.sql` added by this change; `ci/checks/known_tenant_tables.txt` byte-unchanged; the audit path uses `appendAuditEventInput` (no parallel writer). | `ci/checks/dual-control-isolation.sh` git-diff + grep |
| FF-DC8  | Frozen foundation (NF-5, AC-15): change does not touch `role-criticality.ts`/`grant-lattice.ts`/`data-classification.ts`/`effect-resource.ts`/`grant-resolver.ts`/`object-handle.ts` (byte-level git-diff). | `ci/checks/dual-control-isolation.sh` git-diff frozen-paths |
| FF-DC9  | `tsc --noEmit` clean + `eslint src` clean (AC-15).                                          | `npm run build` / `npm run lint` in `ci` |
| FF-DC10 | Determinism unit (AC-17): a property test asserts `dualControlDecision(x)` deep-equals a second call with the same `x`. | `vitest` `dual-control.test.ts` |

The behavioural AC-1..12/14/17 are covered by `src/__tests__/dual-control.test.ts` (pure
decision-function tests) + `dual-control.gate.e2e.test.ts` (the write-path enforcement, AC-10/11).

---

## 5. Traceability (AC → design locus)

| AC    | covered_by |
|-------|------------|
| AC-1  | `dualControlDecision` §3.2/§3.6 — `required_approvers===2` when `criticalityDiff(from,to).escalates`; `dual-control.test.ts` |
| AC-2  | §2.1 + §3.6 — `escalates===false` ⇒ `required_approvers===1`; `dual-control.test.ts` |
| AC-3  | §3.7 distinctness — `{required:2, ['a','b'], proposedBy:'p'}` ⇒ satisfied |
| AC-4  | §3.7 — two-approver not satisfied by one approver |
| AC-5  | §3.7 — duplicate ids collapse (`['a','a']` ⇒ not satisfied) |
| AC-6  | §3.7 — proposer-exclusion (`['a','p']`, proposer `p` ⇒ not satisfied) |
| AC-7  | §3.7 — single-approver: `['a']` ✓, `['p']` ✗ |
| AC-8  | §3.8 — `from`/`to` via `combineCriticality` (compiled, not row-diff); re-stating a held grant ⇒ `from≡to` ⇒ required 1 |
| AC-9  | §2.1 — each axis a/b/c flipping `false→true` from an all-false `from` makes `to.level==='critical'`, `from.level==='routine'` ⇒ `escalates` ⇒ required 2 (three cases) |
| AC-10 | §3.8 integration — unsatisfied gate throws `DUAL_CONTROL_UNSATISFIED`, no confirmed row / no `status:satisfied` flag; `dual-control.gate.e2e.test.ts` |
| AC-11 | §3.8 — routine change: 1 approver `≠ proposer`, effective-diff recorded, WORM `dualcontrol.gate` event emitted; e2e test |
| AC-12 | §3.4/§3.5 — `effective_diff` = serialized `CriticalityDiff`, `change_ref`, distinct `approvers[]`, `status` in the audit payload |
| AC-13 | FF-DC3 — import + no re-derivation of the three axes |
| AC-14 | §3.3 `malformed_input` + NF-2 — malformed `from`/`to`/approvers ⇒ denies (no satisfiable single-approver result); test |
| AC-15 | FF-DC8/FF-DC9 — frozen files untouched; `tsc`/`eslint` clean |
| AC-16 | FF-DC7 — derived: no migration ≥031 added, `known_tenant_tables.txt` byte-unchanged (asserted) |
| AC-17 | FF-DC10 — determinism property test |
| AC-18 | FF-DC5 — no `sod_constraint` read/write, no T-0032 evaluator call |

Plus **Q-2 coverage** (beyond the 18 AC, per orchestrator ruling): a test asserts a newly-added
read grant with a garbage `clearance` token ⇒ `required_approvers===2`,
`reason==="implicit_escalate_clearance"`, even though `criticalityDiff.escalates===false`.

---

## 6. Runtime / deploy target

**Local + dev silo** (no new external resource). The pure module runs in-process; the gate
call-site runs inside the existing `node` HTTP server over the dev Postgres silo. No founder
provision (GT-4) needed — `ddl_needed: none`, no new table, no new server.

---

## 7. Rejected alternatives

| option | why_not |
|--------|---------|
| Persist `confirmation_flag` as a new `tenant_id`-bearing table (+ migration 031, RLS, `known_tenant_tables.txt` churn, cross-tenant fitness case) | Q-1 ruling: day-1 minimum is a DERIVED decision + WORM audit. A table duplicates state already reconstructable from `audit_event` + grant rows, adds a tenant-isolation surface and migration cost the spec §6 explicitly parks for the downstream approval-workflow task. T-0040 §6-B precedent. |
| Re-derive the three axis bits inside the gate (skip T-0040) | Splits the source of truth (FR-8, AC-13). The gate and the computation could drift silently — the exact anti-pattern T-0040 froze the seam to prevent. Gate consumes `criticalityDiff`/`combineCriticality`, never re-derives. |
| Inherit T-0040's R-1 under-flag (garbage clearance ⇒ no escalation) | Q-2 ruling rejects the permissive direction: it leaves a class of garbage-clearance privilege expansions completing with one approver — the precise preventive-brake case D-A=A3 was chosen to close. Fail-closed (NF-2): a non-derivable clearance on an added read grant is an implicit escalate. |
| Edit `role-criticality.ts`/`data-classification.ts` to make axis c over-flag on corrupt clearance | Frozen foundation (NF-5). The fix lives on T-0044's side as a detector over the change's added read grants reusing `isDataClass`; the frozen modules stay byte-untouched. |
| Introduce a two-phase propose→confirm endpoint pair + durable half-confirmed state (migration 031) | Q-3 ruling: the multi-request human-approval workflow is a DOWNSTREAM consumer (spec §5/§6). Day-1 attaches the gate at the existing single-INSERT write-path with `approvers[]` in one request — the gate is exercised end-to-end by a real consumer (D-056 integration-honesty) with zero DDL. The durable workflow task, if ever built, owns migration 031. |
| Add a new audit writer / parallel audit path for `dualcontrol.gate` | NF-7: emission MUST use the existing T-0031 encoder contract + the canonical `appendAuditEventInput` in the same transaction. T-0044 adds only a thin pure `AuditEventInput` encoder, not a second append path. |
| Have the gate call the T-0032 SoD evaluator to "reuse" the distinctness check | AC-18: dual-control and SoD are independent gates. SoD answers "are these two roles incompatible for one principal"; dual-control answers "did a criticality expansion get two distinct approvers". Coupling them conflates two orthogonal controls. |

---

## 8. Friction / notes to next phase

- **FE-2026-W24-0044-A (recorded):** `criticalityDiff.escalates` fires only on
  `routine→critical`, so adding a *second* critical axis to an *already-critical* role does
  NOT re-trigger dual-control via `escalates` (§2.1). This is the frozen T-0040 contract;
  T-0044 honors it. If product later wants "any newly-raised axis triggers a fresh
  dual-control even within an already-critical role", that is a T-0040 contract change (a new
  task), not a T-0044 edit. The per-axis `expanded` bits are preserved in `effective_diff`
  for any downstream finer policy.
- **Coder seam:** the `from`/`to` fold needs the role's currently-effective grants at the
  call-site. On dev `91f991e` the write-path already opens a `withTenantTx`; the coder reads
  the role's grant rows there (a `SELECT … FROM choros."grant" WHERE role_id = $`), folds via
  `combineCriticality`, and folds again with the proposed grant appended. The live DAO binding
  is T-0053; day-1 reads inside the existing transaction.
- **Tester seam:** AC-10/11 need the e2e write-path test (real INSERT rejected/allowed +
  `audit_event` row asserted). AC-1..9/12/14/17 + Q-2 are pure unit tests on `dual-control.ts`.
- **Status flip:** `spec.contract.json` status is advisory; this ADR records the resolution
  (`blocked → ready-with-ruling`). The spec contract is updated to `ready` with a
  `ruling_ref` note (see §1) in the same commit.
