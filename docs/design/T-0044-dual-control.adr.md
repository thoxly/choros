# ADR T-0044 — Dual-control gate keyed to criticality (E4.6, D-A = A3)

> **REV-2 (BINDING, 2026-06-11) — authenticated second approver.** The orchestrator found
> that rev-1 §Q-3 routed **both** approver identities through a single request's body
> (`approvers: string[]`), authenticated by **one** `x-dev-user` actor. That is **decorative**
> dual-control: one authenticated principal could name any second approver in the body and
> satisfy a two-approver gate alone — the same class of hole as `isGenesisOwner`-from-body that
> T-0030 closed, and it **inverts** the meaning of D-A=A3 (the preventive brake becomes a
> rubber stamp). **§9 (rev-2) below SUPERSEDES the body-asserted `approvers[]` mechanism of
> §Q-3/§2/§3.8.** Wherever rev-1 reads "`approvers[]` from the request body", read §9: each
> approver's identity is taken **only** from the authenticated context (`extractActor`) of
> **that approver's own request**. The pure `dualControlDecision` core (§2/§3) is unchanged;
> what changes is *who may assert an approver* and the *two-request* enforcement shape.

- **Task:** T-0044 (E4.6) · product Choros
- **Phase:** DESIGN
- **Branch:** `task/T-0044-dual-control` (base dev `91f991e`)
- **Status:** `ready` (the 3 SPEC-blocking questions are resolved by an **orchestrator
  ruling** under the ratified `founder-autonomy-impl` frame: direction D-A=A3 is signed,
  the *implementation shape* of Q-1..Q-3 is autonomous; the ruling is applied as a given
  below and recorded in friction ledger `FE-2026-W24-0044`). **Rev-2 amendment §9 binds:
  authenticated-only approver identity; see banner above.**
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

> **SUPERSEDED IN PART BY §9 (rev-2).** The "two approvers in **one** request as `approvers: string[]`"
> mechanism below is **withdrawn** (decorative dual-control — see §9.1). Read §9: each approver is
> authenticated in its **own** request; an escalating change is a **two-request** flow with a durable
> `semi-confirmed` state (`confirmed2_by IS NULL`); `ddl_needed` is now `031_grant_confirmed2_by`
> (additive column). The rest of Q-3 below (single-confirmer columns carrying the record, the
> "durable half-confirmed downstream workflow" framing) is **reframed**: the minimal two-request
> half-confirmed state IS now in day-1 scope (that is what authenticity forces), while the richer
> human-approval **UI/routing** workflow remains downstream.

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

> **SUPERSEDED BY §9 (rev-2):** the pseudocode above shows `approvers` arriving in one request
> body — that mechanism is **withdrawn**. Use the §9.6 two-request, authenticated-only write-gard:
> `approvers` to `dualControlDecision` is `[]` at req#1 (proposer-as-only-actor), each confirmer
> id comes from `extractActor` of its own request, and `confirmed2_by` (migration 031) durably
> holds the second authenticated approver. `proposedBy` passed to the gate is `extractActor(req)`,
> never a body field.

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
| FF-DC7  | **[REV-2 RELAXED]** Derived-decision + no-new-TABLE (Q-1, NF-6, AC-16): the confirmation *decision* stays derived (no flag table); the **only** migration added is **031** (additive `ALTER TABLE … ADD COLUMN confirmed2_by` on the already-registered `choros."grant"`/`choros.role_assignment`, mirroring 030); `ci/checks/known_tenant_tables.txt` byte-unchanged (additive column, no new table); audit via `appendAuditEventInput`. **Forbidden:** any `CREATE TABLE`, any RLS change, any `known_tenant_tables.txt` edit, any migration other than 031. | `ci/checks/dual-control-isolation.sh` git-diff: only added migration is `031_*confirmed2_by*.sql`, `ALTER TABLE ADD COLUMN` only; `known_tenant_tables.txt` unchanged; no parallel audit writer |
| FF-DC11 | **[REV-2]** Authenticated-only approver provenance (R-AUTH, §9): the `grants.ts` gate call-site sets `confirmed_by`/`confirmed2_by` from `extractActor(req)` and does NOT read approver identity from the body on the dual-control path (no `b["approvers"]`/`body.approvers`, no `b["confirmed_by"]`, no `b["confirmed2_by"]` feeding the gate/INSERT); `dualControlDecision` called with `proposedBy = extractActor(req)`. | `ci/checks/dual-control-isolation.sh` grep gate block: `extractActor` feeds confirm columns; ban body-sourced approver ids |
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
| AC-16 | **[REV-2]** FF-DC7 — migration **031** added (additive `ADD COLUMN confirmed2_by`, mirrors 030); number ≥031, **no new table**, `known_tenant_tables.txt` byte-unchanged (additive column, asserted); Q-1-compliant (status column, not a flag table) |
| AC-17 | FF-DC10 — determinism property test |
| AC-18 | FF-DC5 — no `sod_constraint` read/write, no T-0032 evaluator call |

Plus **Q-2 coverage** (beyond the 18 AC, per orchestrator ruling): a test asserts a newly-added
read grant with a garbage `clearance` token ⇒ `required_approvers===2`,
`reason==="implicit_escalate_clearance"`, even though `criticalityDiff.escalates===false`.

---

## 6. Runtime / deploy target

**Local + dev silo** (no new external resource). The pure module runs in-process; the gate
call-site runs inside the existing `node` HTTP server over the dev Postgres silo. No founder
provision (GT-4) needed — no new server. **[REV-2] `ddl_needed: 031_grant_confirmed2_by`** —
one additive nullable column `confirmed2_by` on `choros."grant"` + `choros.role_assignment`
(mirrors migration 030; **no new table**, no RLS change, `known_tenant_tables.txt` byte-unchanged,
idempotent), applied by the existing `migrations/run.mjs` over the dev silo. The rev-1
`ddl_needed: none` is **withdrawn** (§9.2: it was an artifact of body-faked approvers).

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

## 9. REV-2 AMENDMENT (BINDING) — authenticated second approver

> This section is **normative** and **supersedes** the body-asserted `approvers[]` mechanism of
> §Q-3, §2 (integration-seam paragraph), §3.1 (`approvers` field semantics), and §3.8
> (pseudocode). The pure decision core (§3.2/§3.3/§3.6/§3.7) is **retained unchanged** — it
> still answers "how many distinct approvers are required and is a given distinct set
> sufficient". What rev-2 changes is the **provenance** of every approver id and the
> **enforcement shape**.

### 9.1 The defect rev-2 closes (why §Q-3 was wrong)

Rev-1 satisfied a 2-approver gate from a single `POST` whose body carried
`approvers: ["a","b"]`, authenticated by **one** `x-dev-user` actor (`extractActor`, `grants.ts:795`).
Nothing bound `"a"` or `"b"` to a real authenticated session — one principal asserts both. This is
**body-asserted authority**: identical in kind to `isGenesisOwner` read from the request body
(closed by T-0030 by sourcing genesis-owner from the DB, not the body) and to today's
`confirmed_by = b["confirmed_by"]` (`grants.ts:470`), which lets the proposer name their own
confirmer. A decorative dual-control **inverts** D-A=A3: the founder chose the preventive brake
precisely so that a criticality expansion needs **two real humans**; a body array makes it one.

### 9.2 Binding rule — identity is authenticated-context-only

**R-AUTH (binding):** the identity of **every** approver of a criticality-escalating change is
taken **only** from the authenticated context of **that approver's own request**
(`extractActor(req)` → `x-dev-user`). **No approver identity may originate in a request body.**
Concretely:
- The request body **MUST NOT** carry an `approvers[]` array, a `confirmed_by`, or a
  `confirmed2_by` field for an escalating change. Any such body field on an escalating change is
  **ignored** (and a fitness probe bans the gate call-site from reading approver ids out of the
  body — see FF-DC11).
- `proposed_by` of confirm-request #1 is the **authenticated actor** of that request.
- `confirmed_by` (approver₁) is the **authenticated actor** of confirm-request #1.
- `confirmed2_by` (approver₂) is the **authenticated actor** of a **separate** confirm-request #2.
- The distinctness invariant (§3.7) is enforced over these **three authenticated principals**:
  `proposed_by ≠ confirmed_by ≠ confirmed2_by`, all pairwise distinct.

> **Structural consequence (the honest core finding):** a single HTTP request has exactly **one**
> authenticated actor. Therefore a genuinely-authenticated two-approver gate is **structurally a
> two-request flow** — it cannot be a one-request guard. Rev-1's `ddl_needed: none` was an artifact
> of faking both approvers in one body; rev-2's authenticity requirement makes a **durable
> semi-confirmed state** unavoidable for escalating changes, and that state needs one additive
> column (§9.4). For **routine** (non-escalating) changes nothing changes structurally: a single
> authenticated approver `≠ proposer` in one request still completes them (§9.5).

### 9.3 Mechanism (chosen day-1, option (a) made honest) — minimal two-request

A criticality-escalating change has a **two-phase** life on the **same existing endpoints**
(`POST /api/grants`, `POST /api/role-assignments`) — **no new endpoint**, a phase selector on the
existing write-path:

1. **Confirm-request #1 (propose + first authenticated confirm).** Actor = `extractActor(req)`.
   The gate folds `from`/`to` via `combineCriticality`, computes `criticalityDiff`, and
   `dualControlDecision` returns `required_approvers === 2`. The row is INSERTed in a
   **`semi-confirmed`** state: `proposed_by` and `confirmed_by` = this authenticated actor
   (or `proposed_by` = an earlier proposer if propose/confirm are split; day-1 they coincide as
   the single requesting actor, with `confirmed_by` = actor and `confirmed2_by = NULL`). The
   critical expansion **is NOT active**: `confirmed2_by IS NULL` means "second approver still
   required". A `dualcontrol.gate` WORM event is appended (`status: "pending"`, payload records
   the single authenticated confirmer).
2. **Confirm-request #2 (second authenticated confirm).** Actor = `extractActor(req)` of a
   **different** authenticated session. The write-gard (§9.6) loads the target row, reads its
   `proposed_by` / `confirmed_by` from the **DB row** (not the body), and **requires**
   `actor ≠ proposed_by AND actor ≠ confirmed_by`. On success it sets `confirmed2_by = actor`,
   transitioning the row `semi-confirmed → confirmed`, and appends a **second** `dualcontrol.gate`
   WORM event (`via: "dual-control.second-confirm"`, `confirmed_by: actor`, `status: "satisfied"`).
   A second request by the **same** actor as `confirmed_by` (or as `proposed_by`) is rejected
   `409 DUAL_CONTROL_UNSATISFIED / self_confirm`.

**"Activation" semantics — honest day-1 assessment.** The orchestrator asked whether EFFECTIVE
role→grants resolution should *ignore* a critical assignment that has only one confirm. On dev
`91f991e` there is **no runtime read-path resolver** yet (role→grants EFFECTIVE resolution is the
**T-0053** contract, not on this base — confirmed: §8 "live DAO binding is T-0053"). So day-1
"activation = needs #2" is enforced as **(i) a contract** (`confirmed2_by IS NULL` ⇒ the grant is
`semi-confirmed` and MUST be treated as not-yet-active by any future resolver) **plus (ii) a
write-gard** (the escalating row cannot reach `confirmed` without a second authenticated actor) —
**not** a runtime read-filter. The derived "needs #2" predicate is computable from `criticalityDiff`
on any future read-path; T-0044 records the contract and ships the write-gard. **When T-0053 builds
the resolver, it MUST filter `semi-confirmed` critical grants** (recorded as obligation
FE-2026-W24-0044-B). This is the integration-honest day-1 boundary (D-056): the gate's decision +
write-gard are exercised end-to-end by a real two-request enforced path; the read-side activation
filter is explicitly deferred to the task that owns the read-path, not faked here.

### 9.4 DDL — migration 031 (additive column), now NECESSARY (Q-1-compliant)

Rev-2 makes a durable `semi-confirmed` distinction unavoidable, and approver₂'s authenticated
identity needs a durable home distinct from approver₁'s `confirmed_by`. Per the orchestrator's
**Q-1 ruling** (NO new *table* for a flag; a **status column is OK**), migration **031** adds one
additive nullable column — **identical in shape to migration 030**:

```sql
-- 031 · grant_confirmed2_by (T-0044 E4.6) — additive ALTER TABLE, mirrors 030.
ALTER TABLE choros."grant"
  ADD COLUMN IF NOT EXISTS confirmed2_by text NULL;
-- (and the sibling on choros.role_assignment for the assignment write-path)
ALTER TABLE choros.role_assignment
  ADD COLUMN IF NOT EXISTS confirmed2_by text NULL;
```

No new table, no RLS change, **`known_tenant_tables.txt` byte-unchanged** (additive column on an
already-registered tenant table, exactly as 030's header states). The grant/assignment PK, RLS
policy, and `GRANT TO choros_app` are unchanged. Idempotent (`ADD COLUMN IF NOT EXISTS`).

> **State machine (derived, not a new state table):**
> `confirmed_by IS NULL` → *proposed*; `confirmed_by NOT NULL AND confirmed2_by IS NULL` →
> *semi-confirmed* (active iff the change is **non-escalating**; **inactive** if escalating);
> `confirmed2_by NOT NULL` → *confirmed*. The "is this escalating, so does it need #2" bit is
> **derived** from `criticalityDiff`, never stored — Q-1's derived-not-stored spirit is preserved
> for the *decision*; only the durable approver-identity columns are persisted.

### 9.5 Routine (non-escalating) change — unchanged shape, but `confirmed_by` authenticated

For `required_approvers === 1`, the change completes in **one** request, but **R-AUTH still binds**:
`confirmed_by` is the **authenticated actor**, not `b["confirmed_by"]`. The proposer cannot
self-confirm (`actor ≠ proposed_by`). `confirmed2_by` stays `NULL`. This closes the *pre-existing*
`confirmed_by = b["confirmed_by"]` body-assertion (`grants.ts:470`) for the routine path too — a
strict improvement rev-2 makes mandatory, not optional.

### 9.6 Write-gard pseudocode (rev-2 — supersedes §3.8)

```text
// CONFIRM-REQUEST #1 (propose+first confirm) — POST /api/grants | /api/role-assignments
actor = extractActor(req)                         // authenticated, x-dev-user — NOT from body
// (body MUST NOT carry approvers[]/confirmed_by/confirmed2_by for an escalating change)
within withTenantTx:
  fromCrit = combineCriticality(currentEffectiveRoleGrants)
  toCrit   = combineCriticality(currentEffectiveRoleGrants + proposedGrant)
  decision = dualControlDecision({ from: fromCrit, to: toCrit,
                                   proposedBy: actor, approvers: [], addedReadGrants })
  if decision.required_approvers === 1:
     if actor === proposedBy: throw 409 DUAL_CONTROL_UNSATISFIED/self_confirm   // routine, but ≠ proposer
     INSERT ... confirmed_by = actor, confirmed2_by = NULL        // routine → active
     append dualcontrol.gate (status: satisfied, confirmed_by: actor)
  else: // required_approvers === 2 → SEMI-CONFIRMED, NOT active
     INSERT ... proposed_by = actor, confirmed_by = actor, confirmed2_by = NULL
     append dualcontrol.gate (status: pending, confirmed_by: actor)
     // 202/200 with state: "semi-confirmed", second approver required

// CONFIRM-REQUEST #2 (second authenticated confirm) — same endpoints, phase=confirm2 on change_ref
actor2 = extractActor(req)                         // authenticated — the SECOND human
within withTenantTx:
  row = SELECT proposed_by, confirmed_by, confirmed2_by FROM <target> WHERE id=$change_ref  // DB, not body
  if row.confirmed2_by IS NOT NULL: throw 409 DUAL_CONTROL_UNSATISFIED/already_confirmed
  if actor2 === row.proposed_by OR actor2 === row.confirmed_by:
       throw 409 DUAL_CONTROL_UNSATISFIED/self_confirm       // distinctness over AUTHENTICATED ids
  UPDATE <target> SET confirmed2_by = actor2 WHERE id=$change_ref AND confirmed2_by IS NULL
  append dualcontrol.gate (via: "dual-control.second-confirm", confirmed_by: actor2, status: satisfied)
```

The distinct approver set fed to `buildConfirmationFlag` / `encodeDualControlAuditEvent` is now
`{confirmed_by(req#1), confirmed2_by(req#2)}` — both authenticated, never body-asserted.

### 9.7 New fitness function (rev-2)

| id      | rule | ci_check |
|---------|------|----------|
| FF-DC11 | **Authenticated-only approver provenance (R-AUTH).** The gate call-site in `grants.ts` MUST set `confirmed_by`/`confirmed2_by` from `extractActor(req)` and MUST NOT read approver identity from the request body for an escalating change: no `b["approvers"]`, no `b["confirmed_by"]`, no `b["confirmed2_by"]` feeding the gate/INSERT for the dual-control path; `dualControlDecision` is called with `proposedBy = extractActor(req)`. | `ci/checks/dual-control-isolation.sh` — grep the gate block: assert `extractActor` feeds `proposed_by`/`confirmed_by`/`confirmed2_by`; ban `b["approvers"]`/`body.approvers`/`b["confirmed2_by"]` reaching the gate; ban any `approvers`/`confirmed2_by` body-read in the dual-control path |

FF-DC11 is appended to `ci/checks/dual-control-isolation.sh` alongside FF-DC1..FF-DC8 and runs in
`npm run fitness`.

### 9.8 Re-traced AC (rev-2 deltas)

| AC | rev-2 covered_by |
|----|------------------|
| AC-3 | §3.7 distinctness over **authenticated** ids: `confirmed_by`(req#1) and `confirmed2_by`(req#2), both from `extractActor`; e2e two-request test |
| AC-4 | §9.3/§9.6 — a single confirm leaves the escalating row `semi-confirmed` (`confirmed2_by IS NULL`), **not active**; one approver never satisfies a 2-approver gate |
| AC-6 | §9.6 — proposer-exclusion enforced over the **DB row's** `proposed_by` vs `extractActor(req#2)` (not a body field): `actor2 === proposed_by` ⇒ reject |
| AC-10 | §9.3/§9.6 — a criticality (a/b/c) change cannot reach `confirmed` with a single authenticated actor: req#1 lands `semi-confirmed`; only a **distinct** authenticated req#2 sets `confirmed2_by`; e2e asserts a same-actor req#2 is rejected and the row stays `semi-confirmed` |
| AC-11 | §9.5 — routine change completes in one request with `confirmed_by = extractActor(req)` `≠ proposer`, effective-diff + WORM event; **no** body-asserted confirmer |
| AC-12 | §3.4/§3.5 — `approvers[]` in the flag/payload is now the **authenticated** `{confirmed_by, confirmed2_by}` set; two WORM `dualcontrol.gate` events for the escalating path (pending @ req#1, satisfied @ req#2) |
| AC-13/15 | unchanged (pure-core import + frozen-foundation untouched) |
| **AC-NEW (rev-2)** | **R-AUTH**: FF-DC11 — no approver identity from the request body; both approvers from `extractActor`; e2e asserts a body-supplied `approvers`/`confirmed2_by` is ignored and a single authenticated actor cannot self-satisfy a 2-approver gate |

The pure-unit AC (AC-1/2/5/7/8/9/14/17) are **unchanged**: `dualControlDecision` is still called with
a distinct-id array; rev-2 only constrains that the array's members are sourced from authenticated
contexts at the call-site, which is a call-site/fitness concern (FF-DC11), not a core-signature change.

---

## 8. Friction / notes to next phase

- **FE-2026-W24-0044-A (recorded):** `criticalityDiff.escalates` fires only on
  `routine→critical`, so adding a *second* critical axis to an *already-critical* role does
  NOT re-trigger dual-control via `escalates` (§2.1). This is the frozen T-0040 contract;
  T-0044 honors it. If product later wants "any newly-raised axis triggers a fresh
  dual-control even within an already-critical role", that is a T-0040 contract change (a new
  task), not a T-0044 edit. The per-axis `expanded` bits are preserved in `effective_diff`
  for any downstream finer policy.
- **FE-2026-W24-0044-B (rev-2, obligation on T-0053):** day-1 "activation = needs second approver"
  is enforced by **contract + write-gard**, not a runtime read-filter, because the EFFECTIVE
  role→grants resolver does not yet exist on dev `91f991e` (it is T-0053). When T-0053 builds the
  resolver it **MUST** treat an escalating grant/assignment with `confirmed2_by IS NULL`
  (`semi-confirmed`) as **not active** (filter it out of EFFECTIVE resolution). Recorded as a
  binding downstream obligation so the read-side does not silently activate a half-confirmed
  critical expansion. The "needs #2" predicate is derivable from `criticalityDiff` at resolution
  time; no stored flag.
- **FE-2026-W24-0044-C (rev-2, pre-existing body-assertion closed):** rev-2 also closes the
  pre-existing `confirmed_by = b["confirmed_by"]` (`grants.ts:470`) body-assertion on the routine
  path — `confirmed_by` is now `extractActor(req)`. The coder must update the existing INSERT
  call-sites (grant + assignment) to source `confirmed_by`/`confirmed2_by` from the authenticated
  actor, not the body, on the dual-control path. FF-DC11 enforces this.
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
