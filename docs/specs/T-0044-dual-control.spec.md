# T-0044 SPEC — E4.6 Dual-control gate keyed to criticality (D-A = A3)

- **Task:** T-0044 (E4.6) · product Choros
- **Phase:** SPEC
- **Branch:** `task/T-0044-dual-control` (base dev `91f991e`)
- **Status:** `needs_founder` (3 BLOCKING design questions — see §7)
- **Refs:** rbac-backlog.md §E4.6; hypothesis §7 D-A (GT-1 signed: **D-A = A3**), §6-A #11
  (EFFECTIVE-expansion trigger), §6-B (standing fork → A3), §5 (`confirmation_flag`).
- **Consumes (frozen):** `src/core/role-criticality.ts` (T-0040) — `RoleCriticality`,
  `criticalityDiff`, `combineCriticality`, `criticalityLevel`, `CriticalityDiff`,
  `RoleGrantSource`, `SENSITIVE_READ_THRESHOLD`. T-0044 **MUST NOT** recompute the bits
  (FR-7 single source of truth).
- **Adjacent (do not touch):** T-0032 SoD (`sod_constraint`) — dual-control ≠ SoD; T-0030/T-0022
  write-paths (`src/http/grants.ts`) — where `proposed_by`/`confirmed_by` are set today.

---

## 0. One-line summary

On a role-assignment confirmation **or** a grant change, compute the role's **EFFECTIVE**
criticality expansion (compiled from→to, not naive row-diff) and gate completion on **two distinct
approvers iff** any criticality axis (a `approve_or_transition` / b `external_invoke` /
c `sensitive_read`) is newly raised, **else** a single scoped-approver — recording the decision and
its rationale as a `confirmation_flag`; the single-approver path still gets effective-diff + WORM
audit.

## 1. Context & boundary

### 1.1 What already exists (dev `91f991e`)

- **T-0040** (`role_criticality`): pure derivation of the three D-A=A3 axis bits + `level`
  (`routine`/`critical`) and a `criticalityDiff(from, to) → {expanded{...}, escalates}` seam.
  T-0040 explicitly named **T-0044 as the consumer** and froze the record shape.
- **T-0030/T-0022** write-paths in `src/http/grants.ts`:
  - `POST /api/grants` — inserts into `choros."grant"` with nullable `proposed_by`/`confirmed_by`
    (migration 030).
  - `POST /api/role-assignments` — inserts into `choros.role_assignment` with
    `proposed_by`/`confirmed_by` (migration 020).
  - Both already gate on `validateAdminDelegation` (scoped-admin authority) **before** the write.
- `proposed_by`/`confirmed_by` today carry **single-confirmer** semantics (one proposer, one
  optional confirmer); there is **no** notion of *N distinct approvers* and **no** enforcement that
  the confirmer ≠ proposer.

### 1.2 What T-0044 adds (this task)

1. A **pure decision function** — given a from-state `RoleCriticality` and a to-state
   `RoleCriticality` (via T-0040 `criticalityDiff`) plus the proposer id and the supplied
   approver id(s), decides: **how many** distinct approvers are required (1 or 2), and whether the
   currently supplied approver set **satisfies** the gate. No IO, `nowMs`-as-parameter, deterministic.
2. The **distinctness invariant**: when two approvers are required, approver₂ ≠ approver₁ ≠
   proposer (three distinct principals); when one is required, approver₁ ≠ proposer.
3. A **`confirmation_flag`** record capturing `{change_ref, effective_diff, approvers[], status}`
   keyed to the EFFECTIVE expansion (per hypothesis §5 / §6-A #11).
4. The **integration seam**: the T-0030 grant write-path and the T-0022 assignment confirm-path
   consult the gate **before** the change is allowed to complete; a change that fails the
   approver-count / distinctness check is rejected (HTTP 4xx) and never written as confirmed.

### 1.3 The "EFFECTIVE expansion" semantics (§6-A #11, the non-negotiable)

The trigger is **not** a naive row-diff (`a new grant row was inserted`). It is the **compiled**
criticality delta: re-derive `RoleCriticality` over the role's grants **as they would be after the
change** (`to`) vs **as they are now** (`from`), via T-0040's `combineCriticality`/`criticalityDiff`.
Dual-control fires iff `criticalityDiff(from, to).escalates === true` — i.e. an axis bit flips
`false→true`. A cosmetic change (re-stating a grant the role's effective criticality already
implies; a `true→true` no-op; a *narrowing* `true→false`) does **NOT** escalate and does **NOT**
require a second approver.

## 2. Functional requirements

- **FR-1 — Decision is a pure function.** A new pure module exports a function (working name
  `dualControlDecision`) taking `{ from: RoleCriticality, to: RoleCriticality, proposedBy: string,
  approvers: string[] }` and returning a decision `{ required_approvers: 1 | 2, distinct_ok: boolean,
  satisfied: boolean, reason: string }`. No `pg`/`fs`/`net`/`http`; no `Date.now()` (time, if needed,
  is a parameter). Equal inputs ⇒ deep-equal output.
- **FR-2 — Two-approver trigger keyed to criticality.** `required_approvers === 2` **iff**
  `criticalityDiff(from, to).escalates === true` (≡ any of axes a/b/c newly raised). Otherwise
  `required_approvers === 1`. T-0044 obtains `escalates` **only** from T-0040 `criticalityDiff`;
  it does not re-derive the bits.
- **FR-3 — Distinctness invariant.** When `required_approvers === 2`: `satisfied === true` iff
  `approvers` contains ≥2 **distinct** principal ids, **none equal to** `proposedBy`. When
  `required_approvers === 1`: `satisfied === true` iff `approvers` contains ≥1 principal id `≠
  proposedBy`. Duplicate ids in `approvers` collapse (a principal cannot count twice).
- **FR-4 — EFFECTIVE (compiled) expansion, not row-diff.** The `from`/`to` `RoleCriticality` fed to
  the gate are produced by `combineCriticality` over the role's effective grants *before* and *after*
  the proposed change — never a literal row delta. A change that does not flip any axis bit yields
  `required_approvers === 1` even if it inserts/updates grant rows.
- **FR-5 — `confirmation_flag` record.** Each gated change produces a `confirmation_flag`
  `{ change_ref, effective_diff, approvers[], status ∈ {pending, satisfied, rejected} }`, where
  `effective_diff` is the serialized `CriticalityDiff` (`expanded` bits + `escalates`), `change_ref`
  identifies the target change (grant id / assignment id), and `approvers[]` is the recorded distinct
  approver set. **Persistence model is BLOCKING — see Q-1.**
- **FR-6 — Single-approver path is not a bypass.** A non-escalating (routine) change still: (i)
  computes the effective-diff, (ii) requires exactly one approver `≠ proposedBy`, (iii) emits the
  WORM audit event (T-0031 seam), (iv) records a `confirmation_flag` with `required_approvers === 1`.
  "One approver" never means "zero approvers".
- **FR-7 — Integration seam into the write-path.** The T-0030 grant confirm-path and the T-0022
  assignment confirm-path call the gate **before** marking the change confirmed. A change whose gate
  is unsatisfied is rejected with a deterministic error (e.g. HTTP 4xx,
  `code = DUAL_CONTROL_UNSATISFIED`) and is **not** written as confirmed. The gate is the single
  enforcement point; UI is a consumer (it may pre-flight the decision but cannot bypass it).
- **FR-8 — Single source of criticality.** T-0044 imports `combineCriticality` / `criticalityDiff` /
  `RoleCriticality` / `CriticalityDiff` from `src/core/role-criticality.ts` without re-declaration or
  re-implementation. If the T-0040 contract shape changes, that is a BLOCKING upstream break.
- **FR-9 — Tenant isolation derived, not added.** All grant/assignment reads the gate depends on are
  pre-scoped to one tenant (via the existing T-0040 `RoleGrantSource` port / the existing
  `withTenantTx` write-path). T-0044 adds **no** cross-tenant edge. If a new table backs
  `confirmation_flag`, it carries `tenant_id`, is registered in `known_tenant_tables.txt`, and is
  covered by the cross-tenant fitness set (migration **031+**).

## 3. Non-functional requirements

- **NF-1 — Pure core / injected IO.** The decision function imports no `pg`/`fs`/`net`/`http`; any
  DB read/write lives behind the existing write-path / an injected port, mirroring T-0040.
- **NF-2 — Fail-closed bias.** Ambiguity resolves toward **more** control: if the from/to criticality
  cannot be computed, or the approver set is malformed, the gate denies (does not silently allow a
  single-approver completion of a possibly-critical change). Aligns with red-lines "doubt → more
  criticality".
- **NF-3 — Determinism.** The decision function called twice with the same inputs yields deep-equal
  output; no `Date.now()`/RNG in the core.
- **NF-4 — Zero new npm dependency** (zero-dep TS/stdlib, repo convention).
- **NF-5 — Frozen foundations untouched.** The commit does not edit `role-criticality.ts`,
  `grant-lattice.ts`, `data-classification.ts`, `effect-resource.ts`, `grant-resolver.ts`,
  `object-handle.ts`. `tsc --noEmit` passes.
- **NF-6 — Migration seam 031+.** If a table backs `confirmation_flag`, its migration number is
  **031 or higher** (030 is taken by T-0030, already on dev), it carries `tenant_id` + RLS, and
  `known_tenant_tables.txt` + the cross-tenant fitness case are updated in the same change. If the
  flag is derived (no table), `known_tenant_tables.txt` is unchanged and that invariant is asserted.
- **NF-7 — WORM audit preserved.** Audit emission uses the existing T-0031 encoder
  (`writeAssignmentAuditEvent` / the grant-audit seam) in the same transaction as the write; no
  parallel audit path.

## 4. Acceptance criteria (machine-checkable)

| ID | Criterion | verifiable_as |
|----|-----------|---------------|
| AC-1 | `dualControlDecision` returns `required_approvers === 2` when `criticalityDiff(from,to).escalates === true` (e.g. from = all-false, to = `approve_or_transition:true`). | test |
| AC-2 | `dualControlDecision` returns `required_approvers === 1` when `escalates === false` (from = to, or a `true→false` narrowing, or a `true→true` no-op). | test |
| AC-3 | Two-approver path: `{required:2, approvers:['a','b'], proposedBy:'p'}` ⇒ `satisfied === true`; `approvers` distinct from each other and from `proposedBy`. | test |
| AC-4 | Two-approver path is **not** satisfied by one approver: `{required:2, approvers:['a'], proposedBy:'p'}` ⇒ `satisfied === false`. | test |
| AC-5 | Distinctness: `{required:2, approvers:['a','a'], proposedBy:'p'}` (duplicate) ⇒ `satisfied === false` (a principal cannot count twice). | test |
| AC-6 | Proposer-exclusion: `{required:2, approvers:['a','p'], proposedBy:'p'}` ⇒ `satisfied === false` (an approver equal to the proposer does not count). | test |
| AC-7 | Single-approver path: `{required:1, approvers:['a'], proposedBy:'p'}` ⇒ `satisfied === true`; `approvers:['p'], proposedBy:'p'` ⇒ `satisfied === false`. | test |
| AC-8 | Effective (compiled) trigger, not row-diff: a change that re-states an already-held grant (axis bits unchanged, `from`≡`to`) yields `required_approvers === 1` even though a row would be written. | test |
| AC-9 | Each of axes a/b/c individually flipping `false→true` independently triggers `required_approvers === 2` (three separate cases). | test |
| AC-10 | A criticality-(a/b/c) assignment cannot complete via the write-path with a single approver: the gate rejects (e.g. HTTP 4xx `DUAL_CONTROL_UNSATISFIED`) and no confirmed row / no `status:satisfied` flag is written. | test |
| AC-11 | A routine, non-escalating in-subtree change completes with exactly one approver `≠ proposer`, with effective-diff recorded and the WORM audit event emitted. | test |
| AC-12 | `confirmation_flag` for a gated change carries the serialized `CriticalityDiff` (`expanded` bits + `escalates`) as `effective_diff`, the `change_ref`, the distinct `approvers[]`, and a `status`. | test |
| AC-13 | T-0044 imports `combineCriticality`/`criticalityDiff`/`RoleCriticality`/`CriticalityDiff` from `src/core/role-criticality.ts`; a fitness check asserts T-0044 does NOT redeclare/re-implement the three axis derivations (single-source-of-truth, FR-8). | fitness |
| AC-14 | Fail-closed: when `from`/`to` cannot be computed (e.g. malformed input to the gate), the decision denies (does not return a satisfiable single-approver result). | test |
| AC-15 | `tsc --noEmit` clean; `eslint src` clean; no edit to `role-criticality.ts`/`grant-lattice.ts`/`data-classification.ts`/`effect-resource.ts`/`grant-resolver.ts`/`object-handle.ts` (git-diff fitness). | fitness |
| AC-16 | Migration-seam: if a `confirmation_flag` table is added its migration number is ≥ 031, it carries `tenant_id` + RLS, and `known_tenant_tables.txt` + the cross-tenant fitness case include it; if derived, `known_tenant_tables.txt` is unchanged (asserted). | fitness |
| AC-17 | Determinism: `dualControlDecision` called twice with identical inputs returns deep-equal output. | test |
| AC-18 | SoD boundary: the gate does NOT read/write `sod_constraint` and does NOT call the T-0032 SoD evaluator; dual-control and SoD are independent checks (a change may pass SoD yet be blocked by dual-control, and vice-versa). | fitness |

## 5. Out of scope

- Re-implementing or tuning the three criticality axes or the threshold — owned by T-0040 (frozen).
- The Postgres DAO / `RoleGrantSource` live binding — deferred to T-0053.
- SoD evaluation (`sod_constraint`, static/dynamic incompatibility) — T-0032; dual-control is a
  **separate** gate (AC-18 fixes the boundary).
- The approval **UI/workflow** (approver queues, notifications, multi-step approval routing) — a
  frontend/orchestration consumer of the gate, not this task. T-0044 builds the gate mechanics and
  one write-path enforcement point; the human approval UX is downstream.
- Break-glass / emergency-override path — not in the E4.6 scope; if needed it is a later task.
- Stage-2 agent-runtime concerns (autonomy downgrade, A2A breakers, agent-as-approver semantics).
- BYO-LLM egress criticality axis — E4.8 / separate task.

## 6. Notes / seams to the next phase (architect)

- **R-1 under-flag (T-0040 handoff, recorded for T-0044).** Axis c (`sensitive_read`) inherits
  T-0033 `deriveClearance` quiet-null: a **corrupt/unknown** clearance marker on a read grant
  resolves to `null` ⇒ `sensitive_read = false` (**under-**flag, not over-flag). This means a change
  that grants a read whose clearance token is *garbage* will NOT escalate to dual-control even though
  "doubt → more criticality" (NF-2) would argue it should. **This is a genuine cross-task design
  question for the gate's stance — Q-2 (BLOCKING).** It is spec-conformant to T-0040/T-0033 (frozen),
  so T-0044 cannot fix it by editing those modules; the question is whether T-0044 must treat a
  non-derivable clearance on a newly-added read grant as an *implicit escalate* before consulting
  `criticalityDiff`.
- **`confirmation_flag` shape (§5 hypothesis):** `(change_ref, effective_diff, approvers[], status)`.
  Whether this is a **persisted table** (control-plane record, queryable history, RLS, migration 031)
  or a **derived/in-request decision object** (no table; the audit_event carries the rationale) is a
  scope-determining BLOCKING question — Q-1. The backlog §5 schema list presents it alongside stored
  tables, but the day-1 minimum could be a derived check + audit. This changes whether there is a
  migration, a new tenant table, `known_tenant_tables.txt` churn, and a cross-tenant fitness case.
- **Where enforcement attaches (Q-3, BLOCKING).** The existing write-path sets
  `proposed_by`/`confirmed_by` at INSERT time (a single optional confirmer). Does the gate enforce at
  the **same** `POST /api/grants` / `POST /api/role-assignments` insert (a change is born already
  confirmed-or-rejected), or does T-0044 introduce a **two-phase** confirm step (propose → one or two
  approvers confirm → completion), which the current single-INSERT path does not model? The
  two-approver requirement structurally implies a multi-actor flow that the present write-path cannot
  express in one request. This determines whether T-0044 is a function + one guard call, or a new
  propose/confirm endpoint pair.
- **Day-1 honest boundary (D-056 integration honesty):** the gate's *core decision function* + a
  *single real enforced write-path call* are day-1; the multi-step human approval workflow is a
  consumer. The architect must pick the enforcement attachment (Q-3) so the gate is exercised
  end-to-end by a real consumer, not left as dead code (mirrors the T-0040 integration-honesty seam).

## 7. BLOCKING questions (GT-1 — founder must answer before DESIGN)

- **Q-1 — Is `confirmation_flag` a persisted table or a derived decision object?**
  *Why blocking:* determines whether T-0044 adds a migration (031+), a new `tenant_id`-bearing
  table, `known_tenant_tables.txt` + cross-tenant fitness changes, and queryable approval history —
  versus a pure decision + audit-only record. Scope, migration count, and the tenant-isolation
  surface all change with the answer.
- **Q-2 — Gate stance on corrupt/non-derivable clearance (R-1 under-flag).** Must a newly-added read
  grant whose clearance marker is **not** a derivable `DataClass` be treated as an **implicit
  escalate** (force dual-control) before consulting T-0040's `criticalityDiff`, or does T-0044 inherit
  T-0040's under-flag (no escalation on garbage clearance)?
  *Why blocking:* changes whether a class of "garbage-clearance" privilege expansions silently
  complete with one approver. This is the exact preventive-brake case D-A=A3 was chosen to close, so
  the founder must rule on the safe-vs-permissive direction.
- **Q-3 — Enforcement attachment: single-INSERT guard vs two-phase propose/confirm flow?**
  *Why blocking:* the two-approver requirement implies a multi-actor confirm flow the current
  single-request write-path (`proposed_by`/`confirmed_by` at INSERT) cannot express. The answer
  decides whether T-0044 is a decision function + one guard call on the existing endpoint, or a new
  propose→confirm endpoint pair (a materially larger scope and a different DB-state model).
