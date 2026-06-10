# ADR · T-0032 — SoD constraints (static + dynamic) as queries over the ledger; `approve`/`transition` = guarded class (E4.2)

- **Task:** T-0032 (epic E4.2, day-1)
- **Phase:** DESIGN · role `architect`
- **Base:** dev `9409a75` (after T-0033/T-0034 merged; resolver step 3.5 = T-0034 effect-verify).
- **Spec:** `docs/specs/T-0032-sod-constraints.spec.md` (20 AC, `status: ready`, no BLOCKING questions).
- **Status:** `ready`.

---

## 1. Context

T-0019 (E4.1, migration 018 + `src/core/actor-event.ts`) shipped the typed append-only
actor-event ledger **and froze two contracts it deliberately did not implement** — the
guarded-transition writer `ActorEventWriter.appendActorEvent` (tagged "T-0021/E4.2") and the
SoD read substrate `ActorEventReader` (three queries `trail` / `didPrincipalPerform` /
`rolesThatActed`, tagged "T-0032/E4.2"). Today only the deny stubs
`notImplementedActorEventWriter` / `notImplementedActorEventReader` exist.

T-0021 (`src/core/grant-resolver.ts`) is the single PDP chokepoint: `resolveFor(deps, handle,
subject, op, invokeCtx?)` turns an opaque `ObjectHandle` into a grant-filtered `ResolvedView`,
operation-parameterized (`op ∈ {read, create, update, delete, approve, transition, invoke}`).
T-0034 set the binding precedent for *additive enforcement*: external-effect verification was
folded into `resolveFor` as **step 3.5**, guarded by `op === "invoke"`, behind an **optional
injected port** `deps.effects`, fully backward-compatible when absent, and the SoD evaluation
itself lives in a sibling pure module (`effect-resource.ts`) imported by the resolver — no second
authorization subsystem.

T-0032 implements **both halves of E4.2**: the SoD reader *and* the guarded-transition writer.
The guard is one indivisible action-time step — on a guarded op the gateway must (i) read the
ledger / role-assignments to decide SoD, then (ii) append the actor_event row recording the act.
Owning the writer means the **forward debt F-T0019-1 / FO-T0019-1** (no-decrement guard on
`actor_event_seq`) is T-0032's.

---

## 2. Decision

**The SoD guard is an additive "step 3.6" inside the existing `resolveFor` body**, active iff
`op ∈ {approve, transition}` AND an optional injected port `deps.sod` is present. It is the exact
structural analogue of T-0034's step 3.5 (`op === "invoke"` + `deps.effects`): a new branch in the
one decision core, NOT a second authorization module. The SoD evaluation logic lives in a **new
pure module `src/core/sod.ts`** (the static/dynamic decision functions, the `SodSource`
constraint-loading port, and the guarded-transition writer factory), imported by
`grant-resolver.ts` exactly as `effect-resource.ts` is.

On a guarded op:

1. Steps 1–4 of `resolveFor` run unchanged (tenant-gate → grants → covering filter → `no_grant`).
2. **Step 3.6 (new):** when `op ∈ {approve, transition}` AND `deps.sod` present, evaluate SoD:
   - **static SoD** — the acting principal must not hold an incompatible role pair (a
     `sod_constraint(kind='static', role_a, role_b, scope)`) within any constraint scope covering
     the object, evaluated over **effective** `role_assignment` rows;
   - **dynamic SoD** — the acting principal must not collide with an earlier conflicting verb on
     the same object per a `sod_constraint(kind='dynamic', …, self_record, scope)`, evaluated over
     the actor_event trail via the T-0019 read contract (attribution =
     `COALESCE(on_behalf_of, actor)`).
   On any violation → return `{ denied: true, reason: 'sod_violation' }` (fail-closed). The denial
   short-circuits *before* the record fetch and *before* the writer — **zero** actor_event rows.
3. Step 5 (record fetch) runs.
4. **On PASS** (covering grant ∧ SoD clear ∧ record found), the gateway appends **exactly one**
   actor_event row via the injected `deps.sod.writer.appendActorEvent(...)`, recording the act
   (`actor`, `onBehalfOf`, `roleAtEvent`, `event`, `approveLevel`), then projects and returns.
5. Step 6 (project once) returns `{ denied:false, ref, fields }` — `ResolvedView` shape unchanged.

**`approve`/`transition` is a first-class guarded class:** there is no ungated path for these ops
through the gateway when `deps.sod` is wired. Absent `deps.sod`, the step is skipped and the gateway
degrades to pre-T-0032 covering-grant-only behavior (NF-2, backward-compatible) — identical to the
T-0034 `deps.effects`-absent floor.

**SoD is queries-only — no new derived state.** Static SoD is a query over effective
`role_assignment` rows; dynamic SoD is recomputed from `actor_event` rows at action-time (TOCTOU-
safe, like the grant check). The only new table is `sod_constraint` (the *declarations*, not a
decision cache).

### 2.1 Transactional semantics (the one open judgment call — RESOLVED)

**The SoD read and the actor_event write on a guarded op are ONE transaction, bound to the same
`withTenant` connection at the DAO layer.** Rationale and how T-0032 expresses it in static-now:

- `resolveFor` is the **pure decision core** — it does no IO of its own; all IO is behind injected
  ports, and the Postgres-backed DAO for every port (`GrantSource`, `RecordSource`, `SodSource`,
  `ActorEventReader`, `ActorEventWriter`) lands in **T-0053**. This is the established discipline
  (T-0021/T-0033/T-0034).
- The atomicity guarantee is therefore a **DAO-layer contract (T-0053)**, not a thing the pure core
  can enforce by itself: in T-0053 the Postgres `SodSource`/`ActorEventReader`/`ActorEventWriter`
  for one guarded `resolveFor` call MUST be constructed over the SAME `withTenant(pool, tenant, fn)`
  `PoolClient` (one `BEGIN … COMMIT`), so the SoD read and the append are TOCTOU-safe and the row is
  rolled back if the surrounding transaction aborts. The existing `src/db/org.ts` `withTenant`
  helper (`BEGIN; SET LOCAL choros.tenant_id; … COMMIT`) is the exact shape T-0053 reuses.
- **What T-0032 ships now** makes this expressible and testable without the DB: the writer is
  invoked *inside* the guard (after the SoD decision, on PASS), so "read-then-append on the same
  logical step" is structurally true in the core; the in-memory ports share one backing store in
  tests; and the **exactly-one-row-on-pass / zero-on-deny** invariant (AC-10) is the testable
  surrogate for atomicity. The "same-`withTenant`-transaction" requirement is pinned as a fitness
  obligation handed to T-0053 (FF-SOD8), not silently assumed.

This mirrors how T-0034 deferred the effect-resource Postgres DAO to T-0053 while shipping the pure
verification + ports now.

### 2.2 Why the writer + FO-T0019-1 are in scope (recorded, not a question)

The guarded class cannot record its act without the writer; the writer was tagged "T-0021/E4.2" but
T-0021 shipped only the read-path PDP, so its perimeter debt FO-T0019-1 is T-0032's. This widens
T-0032 beyond "implement the 3 reader stubs" — surfaced as **friction** for the orchestrator ledger,
honestly per the E4.2 backlog ("`approve`/`transition` = first-class guarded class").

---

## 3. Rejected alternatives

| Option | Why not |
|---|---|
| **Separate SoD authorization module** (à la T-0029 scoped-admin), called by the engine before/after `resolveFor`. | Breaks the single-chokepoint invariant (NF-5) and creates a second action-time authority path that can diverge from the covering-grant decision. T-0029 is legitimately separate because it pre-filters *which management ops a scoped admin may attempt* (a different axis); SoD is inherently an action-time query over the per-object ledger at the transition instant, so it belongs at the same gateway step the covering grant is decided. Step 3.6 keeps ONE decision core. |
| **A derived `approval_state` / SoD-decision-cache table** updated on each transition. | A second source of truth that can drift from the ledger; reintroduces the read-modify-write the ledger was built to avoid. SoD is recomputable from `actor_event` + `role_assignment` at action-time — TOCTOU-safe like the grant check. Spec §3.2/§6 forbid it. |
| **Software-only no-decrement guard** (validate `next_seq` monotonicity in the TS writer). | Defeatable by any other caller and invisible to CI. The structural fix — a `BEFORE UPDATE` trigger on `actor_event_seq` — is always-on, role-agnostic (rejects even the owner), and requires a CI-visible DDL diff to defeat (spec §3.4 option A, the preferred fix). |
| **Make `deps.sod` a required field on `ResolverDeps`.** | A breaking change to every existing caller and to the frozen-test import surface (NF-6, FE-W23-0008). Must be optional, mirroring `deps.effects`/`deps.classifications`. |
| **Encode static-SoD as a DB CHECK / EXCLUDE constraint on `role_assignment`.** | That is the *assignment-time block* (E4.6/T-0039), explicitly out of scope. T-0032 enforces SoD only on the action-time `approve`/`transition` path + ships the standalone *query* (FR-10). A DB constraint would also edit a frozen table's write-path. |
| **Single migration `027` holding both the table and the trigger.** | Permitted by spec (§3.5 "MAY collapse"), but kept as two files (027 table, 028 trigger) for clean separation of concerns and because the trigger touches a *different* table (`actor_event_seq`, T-0019's) than the new `sod_constraint`. Either is acceptable; the run-seam requirement is only "≥027, lexicographically after 022". |

---

## 4. Object model

### 4.1 TypeScript — new module `src/core/sod.ts`

```ts
// Closed SoD kind axis (mirrors the migration-027 CHECK).
export type SodKind = "static" | "dynamic";

// A SoD constraint DECLARATION row (TS mirror of choros.sod_constraint).
//  - static:  role_a & role_b are the incompatible pair (both non-null).
//  - dynamic: self_record / the conflicting-verb rule; role_a may be null.
//  - scope:   a grant-lattice ScopeElement-shaped jsonb (org or resource hierarchy)
//             whose containment of the object is tested via the AncestryOracle.
export interface SodConstraint {
  tenantId: string;
  id: string;
  kind: SodKind;
  roleA: string | null;   // role uuid; non-null for static
  roleB: string | null;   // role uuid; non-null for static
  selfRecord: boolean;    // dynamic self-record separation flag
  scope: unknown;         // ScopeElement-shaped; opaque to the loader
  detail?: Record<string, unknown> | null;
}

// An EFFECTIVE role assignment, as the static-SoD query consumes it. The
// effectiveness predicate (confirmed_by NOT NULL ∧ in-window ∧ org_scope
// containment) is applied by the SodSource DAO (T-0053) / the in-memory source.
export interface EffectiveAssignment {
  employeeId: string;
  roleId: string;
  orgScope: unknown;      // ScopeElement-shaped; intersected with constraint scope
}

// Injected loader port (pure static-now; Postgres DAO in T-0053). It returns
// only EFFECTIVE assignments and the active constraints — the effectiveness
// filter lives in the DAO, never in sod.ts (sod.ts is pure decision logic).
export interface SodSource {
  // All active SoD constraints in the tenant whose scope MAY cover the object.
  constraintsFor(ref: ActorEventObjectRef): Promise<SodConstraint[]>;
  // Effective assignments for one principal (confirmed, in-window) — static SoD.
  effectiveAssignmentsOf(principal: string): Promise<EffectiveAssignment[]>;
  // The T-0019 reader (dynamic SoD substrate) + writer (the guarded append).
  reader: ActorEventReader;
  writer: ActorEventWriter;
}

// The act the gateway records on a PASS (the writer input minus tenant/seq/id).
export interface GuardedAct {
  ref: ActorEventObjectRef;     // the object the transition targets
  actor: string;                 // performer (employee id)
  onBehalfOf?: string | null;    // principal when ≠ performer
  roleAtEvent: string;           // the role the gateway resolved the actor under
  event: ActorEventVerb;         // the verb (e.g. 'approve')
  approveLevel?: number;         // required iff event==='approve'
}

// SoD decision result (pure).
export type SodDecision =
  | { violated: false }
  | { violated: true; constraintId: string; rule: "static" | "dsod1" | "dsod2" };
```

**Pure decision functions exported by `sod.ts` (FR-12):**

```ts
// Static-SoD detection (FR-2, FR-10, AC-2/AC-3). Pure.
//   Given the principal's EFFECTIVE assignments and the active static
//   constraints, report the first incompatible pair whose scope intersects.
//   A violation = same principal holds role_a AND role_b, and both assignments'
//   org_scope intersect the constraint scope. `scopesIntersect` uses the
//   injected AncestryOracle (no new scope algebra).
export function detectStaticConflict(
  assignments: EffectiveAssignment[],
  constraints: SodConstraint[],
  ancestry: AncestryOracle,
): SodDecision;

// The FR-10 standalone form: would confirming (employee, candidateRole) create a
// static-SoD violation against the principal's existing effective assignments?
// Same core as detectStaticConflict, with the candidate assignment folded in.
export function wouldCreateStaticConflict(
  existing: EffectiveAssignment[],
  candidate: { roleId: string; orgScope: unknown },
  constraints: SodConstraint[],
  ancestry: AncestryOracle,
): SodDecision;

// Dynamic-SoD decision (FR-3, FR-8, FR-9, AC-4..AC-7). Async only because it
// reads the ledger via the injected ActorEventReader; the decision logic itself
// is deterministic given the trail.
//   DSoD-1: a principal who performed a conflicting earlier verb (submit, etc.)
//           on the object may not perform the guarded approve/transition.
//   DSoD-2: the principal who performed approve at level n may not approve at m≠n.
//   Attribution throughout = COALESCE(onBehalfOf, actor) (actorEventPrincipal).
export function evaluateDynamicSod(
  reader: ActorEventReader,
  constraints: SodConstraint[],
  act: GuardedAct,
): Promise<SodDecision>;

// The top-level guard the resolver calls (step 3.6). Loads constraints, runs
// static + dynamic, returns the decision. Fail-closed: any thrown port error /
// malformed constraint ⇒ { violated: true, … } (NF-3) — never a silent pass.
export function evaluateSod(
  source: SodSource,
  ancestry: AncestryOracle,
  act: GuardedAct,
  principalAssignments: EffectiveAssignment[],
): Promise<SodDecision>;
```

**Guarded-transition writer factory (FR-5, FR-12):** `sod.ts` exports
`makeAppendingWriter` is NOT introduced — the writer is the T-0019 `ActorEventWriter` port
implemented by an **in-memory** `InMemoryActorEventStore` (test double) shipped under
`src/core/sod.ts` *or* a sibling `src/core/actor-event-store.ts`; the **coder picks one file**,
but it MUST: (a) implement `ActorEventReader` + `ActorEventWriter` over one shared in-memory
per-tenant list; (b) call `validateActorEventInput` BEFORE the (in-memory) append and reject on
failure (AC-14); (c) advance a per-tenant counter `+1` per append (AC-13 surrogate); (d) never
mutate a prior row (AC-13). The Postgres DAO is T-0053. **`actor-event.ts` is not edited** —
the store *implements* its frozen ports.

> Architect note: the writer/reader in-memory implementation MAY live in a new
> `src/core/actor-event-store.ts` rather than `sod.ts`, to keep `sod.ts` a pure-decision module
> (no mutable store). Both are acceptable; the contract (the four bullets above) is what the tester
> checks. If split, `sod.ts` still re-exports the store factory so FR-12's "consumable without
> re-declaration" holds.

### 4.2 SQL — `migrations/027_sod_constraint.sql` (validated live, see §8)

```sql
CREATE TABLE choros.sod_constraint (
  tenant_id    uuid    NOT NULL,
  id           uuid    NOT NULL,
  kind         text    NOT NULL CHECK (kind IN ('static', 'dynamic')),
  role_a       uuid    NULL,
  role_b       uuid    NULL,
  self_record  boolean NOT NULL DEFAULT false,
  scope        jsonb   NOT NULL,
  detail       jsonb   NULL,
  created_at   bigint  NOT NULL,
  PRIMARY KEY (tenant_id, id),
  -- static constraints MUST name both roles (the incompatible pair); dynamic MAY omit.
  CONSTRAINT sod_constraint_static_shape
    CHECK (kind <> 'static' OR (role_a IS NOT NULL AND role_b IS NOT NULL))
);
ALTER TABLE choros.sod_constraint ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.sod_constraint FORCE ROW LEVEL SECURITY;
CREATE POLICY sod_constraint_tenant_isolation ON choros.sod_constraint
  USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON choros.sod_constraint TO choros_app;
```

- Tenant table (T-0013 verbatim): `tenant_id`-leading PK, ENABLE+FORCE RLS, default-DENY policy on
  the `choros.tenant_id` GUC, DML grant to `choros_app`. **`role_a`/`role_b` carry NO FK to `role`**
  (mirrors `grant.role_id` / `actor_event.role_at_event` — role FK is undesigned; consistent with
  the no-cross-table-FK discipline). The `sod_constraint_static_shape` CHECK is a cheap DB guard
  that a static row is well-formed; deeper scope-shape validation is an application invariant
  (mirrors `role_assignment.org_scope`).
- Added to `ci/checks/known_tenant_tables.txt` (the line `sod_constraint`) — REQUIRED so
  `schema.test.ts` strict-mode set-equality (every DB table ∈ the fixture) and `cross_tenant.test.ts`
  (iterates `KNOWN_TENANT_TABLES`) cover it.
- `cross_tenant.test.ts` gains a `case 'sod_constraint':` in its `seedRowForTable` switch (a
  `seedSodConstraint(c, tenantId)` inserting one valid row) — otherwise the `default: throw` fires.

### 4.3 SQL — `migrations/028_actor_event_seq_no_decrement.sql` (validated live, see §8)

```sql
CREATE OR REPLACE FUNCTION choros.actor_event_seq_no_decrement()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.next_seq < OLD.next_seq THEN
    RAISE EXCEPTION 'actor_event_seq.next_seq must not decrement: % -> %',
      OLD.next_seq, NEW.next_seq USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER actor_event_seq_no_decrement_trg
  BEFORE UPDATE ON choros.actor_event_seq
  FOR EACH ROW EXECUTE FUNCTION choros.actor_event_seq_no_decrement();
```

- Closes FO-T0019-1 structurally (FR-11, AC-16): rejects any `UPDATE` that lowers `next_seq`,
  for ALL roles including the owner `choros_migrator` (defence in depth — exactly the
  `actor_event_immutable` pattern in 018). The forward `+1` advance under `SELECT … FOR UPDATE`
  (the real writer path) passes unchanged (verified live, §8). **Does NOT** grant any new privilege
  and does NOT add a DELETE grant — so `actor_event_append_only.sh` and `actor_event_no_global_seq.sh`
  stay green (verified, §8).

### 4.4 `ResolverDeps` extension — additive optional field only

```ts
export interface ResolverDeps {
  grants: GrantSource;
  records: RecordSource;
  ancestry: AncestryOracle;
  classifications?: ClassificationSource;   // T-0033
  effects?: EffectSource;                    // T-0034
  sod?: SodSource;                           // T-0032 — additive, OPTIONAL (NF-2/NF-6)
  now?: () => number;
}
```

Optional, mirroring `effects`/`classifications`. This is the ONLY edit to `grant-resolver.ts`'s
type surface; every existing export (`resolveFor`, `makeGrantResolver`, `projectFields`,
`visibleFields`, `refToScope`, private `grantFacetFields`) is preserved (FE-W23-0008 / AC-19).

### 4.5 Step 3.6 inside `resolveFor` (guarded-op path) — pseudocode

```
// … steps 1–4 (tenant-gate, grants, covering filter, no_grant) UNCHANGED …
// [step 3.5] T-0034 invoke-path effect verification UNCHANGED …

// [step 3.6] T-0032 — SoD guard. Active ONLY when op ∈ {approve, transition}
//            AND deps.sod present (NF-2 backward-compat floor when absent).
if ((op === "approve" || op === "transition") && deps.sod !== undefined) {
  const act = buildGuardedAct(handle, subject, op, /* approveCtx */);   // performer/principal/role/verb/level
  let principalAssignments: EffectiveAssignment[];
  let decision: SodDecision;
  try {
    principalAssignments = await deps.sod.effectiveAssignmentsOf(
      actorEventPrincipal({ actor: subject.actor, onBehalfOf: subject.onBehalfOf }),
    );
    decision = await evaluateSod(deps.sod, deps.ancestry, act, principalAssignments);
  } catch {
    return { denied: true, reason: "sod_violation" };   // fail-closed (NF-3)
  }
  if (decision.violated) {
    return { denied: true, reason: "sod_violation" };   // zero actor_event rows
  }
}

// 5. Fetch record (UNCHANGED) — null ⇒ not_found (still zero actor_event rows).
const raw = await deps.records.getRecord(handle.ref);
if (raw === null) return { denied: true, reason: "not_found" };

// [step 6.5] On a guarded op that PASSED grant ∧ SoD ∧ record: append EXACTLY ONE
//            actor_event row (AC-10). validateActorEventInput runs inside the writer.
if ((op === "approve" || op === "transition") && deps.sod !== undefined) {
  await deps.sod.writer.appendActorEvent(toActorEventInput(act));   // exactly one row
}

// 6. Project once (UNCHANGED) — { denied:false, ref, fields }.
```

> Resolver-shape notes for the coder:
> - The guarded `act` needs the **performer**, **principal** (`onBehalfOf`), **resolved role**,
>   **verb**, and (for `approve`) **level**. `ResolveSubject` today (`{ tenantId, … }`) does NOT
>   carry actor/onBehalfOf/verb/level — they arrive via an **additive optional `guardCtx?`** param
>   on `resolveFor` (mirroring T-0034's optional `invokeCtx?` 5th arg), NOT by editing
>   `object-handle.ts`/`ResolveSubject`. Shape: `GuardContext = { actor: string; onBehalfOf?: string|null;
>   roleAtEvent: string; verb: ActorEventVerb; approveLevel?: number }`. A guarded op with
>   `deps.sod` present but `guardCtx` absent ⇒ **fail-closed `sod_violation`** (cannot attribute ⇒
>   cannot clear SoD). This is the SoD analogue of T-0034's trust-boundary note, but fail-CLOSED
>   (T-0034 treats missing invokeCtx as pure-compute; SoD treats missing guardCtx as a denial,
>   because an unattributable transition cannot be proven SoD-clean — NF-3).
> - The `reason` union widens to add `"sod_violation"`. Like T-0034's `EffectDeniedView`, define a
>   `SodDeniedView = { denied: true; reason: "sod_violation" }` in `sod.ts` and widen `resolveFor`'s
>   return type; `makeGrantResolver`'s read-path cast stays valid (read never enters step 3.6).

---

## 5. Seam: `ResolvedView` and the `"sod_violation"` reason

`object-handle.ts` is frozen (`ResolvedView.reason ∈ {no_grant, cross_tenant, not_found}`). The new
reason is added the same way T-0034 added `"no_effect_grant"`: a `SodDeniedView = { denied: true;
reason: "sod_violation" }` defined in `sod.ts`, and `resolveFor`'s return type widened to
`Promise<ResolvedView | EffectDeniedView | SodDeniedView>`. Downstream `reason` switches handle the
new literal via their existing default/wildcard branch (backward-compatible widening, AC-9). The
reason is distinct from `no_grant` / `cross_tenant` / `not_found` / `no_effect_grant`.

---

## 6. Module boundary and isolation

`src/core/sod.ts` (and the optional `actor-event-store.ts`) imports **no `pg`/`fs`/`net`/`http`**
(NF-1, AC-20); all DB access is behind `SodSource` / `ActorEventReader` / `ActorEventWriter`. The
static/dynamic decision functions are deterministic (equal inputs ⇒ deep-equal output). No parallel
authority store: SoD constraints are *declarations*; the decision derives from them + grant rows +
the ledger — no `_acl` / `sod_visibility` / `sodRights` token (AC-18). The new module introduces no
second `handle→fields` edge; the one projection stays in `resolveFor` (NF-5,
`ci/checks/single-resolver.sh` green).

---

## 7. Fitness functions (CI-executable)

A new script `ci/checks/sod-isolation.sh` (modelled verbatim on
`ci/checks/effect-resource-isolation.sh`) and additions to existing checks. All are wired into
`npm run fitness` (static) / `npm run fitness:db` (live), gating merge.

| # | Rule | CI check | Verifies AC |
|---|---|---|---|
| **FF-SOD1** | `src/core/sod.ts` imports no `pg`/`fs`/`net`/`http` (and the store module if split). | `ci/checks/sod-isolation.sh` (grep, mirrors ER-ISO2). | AC-20, NF-1 |
| **FF-SOD2** | No parallel SoD-authority store token in `sod.ts` (`_acl`, `sod_visibility`, `sodRights`, `sodAcl`) in non-comment code. | `ci/checks/sod-isolation.sh` (grep, mirrors ER-ISO1). | AC-18, NF-5 |
| **FF-SOD3** | `grant-resolver.ts` import surface preserved: `resolveFor`/`makeGrantResolver`/`projectFields`/`visibleFields`/`refToScope` still exported; `grantFacetFields` still present; `ResolverDeps` gains only an optional `sod?:` field. | `ci/checks/sod-isolation.sh` (grep, mirrors ER-ISO3). | AC-19, NF-6 |
| **FF-SOD4** | Frozen files carry no diff in T-0032's commit: `grant-lattice.ts`, `object-handle.ts`, `actor-event.ts`, `migrations/008_grant.sql`. | `git diff --quiet HEAD -- <each>` inside `sod-isolation.sh` (mirrors grant-resolver-isolation Check 3). | AC-19, NF-6 |
| **FF-SOD5** | `single-resolver.sh` stays green (no second handle→fields export on `object-handle.ts`). | `bash ci/checks/single-resolver.sh` (existing, unchanged). | AC-18, NF-5 |
| **FF-SOD6** | `sod_constraint` ∈ `known_tenant_tables.txt`; `schema.test.ts` strict-set-equality passes; `cross_tenant.test.ts` has a `case 'sod_constraint'` seeding one valid row. | `vitest run --dir ci/checks/db` (schema.test.ts, cross_tenant.test.ts). | AC-15, AC-17, NF-7 |
| **FF-SOD7** | `sod_constraint` is a T-0013 tenant table: tenant-leading PK + ENABLE+FORCE RLS + isolation policy + closed `kind` CHECK; a `kind NOT IN (static,dynamic)` insert is rejected; a TB session reads 0 of TA's rows. | live DB asserts in a new `ci/checks/db/sod.test.ts` (mirrors `effect_resource.test.ts`). | AC-1, AC-15, AC-17 |
| **FF-SOD8** | `actor_event_seq` no-decrement trigger: forward `+1` advance passes; backward `UPDATE` raises for BOTH `choros_app` and `choros_migrator`; the `actor_event_append_only.sh` + `actor_event_no_global_seq.sh` checks stay green. **Plus the T-0053 atomicity obligation**: the Postgres `SodSource`/reader/writer for one guarded `resolveFor` are constructed over one `withTenant` `PoolClient`. | live asserts in `sod.test.ts` (trigger) + `bash ci/checks/actor_event_append_only.sh && bash ci/checks/actor_event_no_global_seq.sh` (unchanged, stay green) + a T-0053 fitness obligation note. | AC-16, AC-13, NF-8 |
| **FF-SOD9** | Step 3.6 gating: SoD guard runs in `resolveFor` IFF `op ∈ {approve, transition}` AND `deps.sod` present; `read/create/update/delete/invoke` never enter it; absent `deps.sod` ⇒ pre-T-0032 behavior, all existing resolver tests pass unchanged. | `vitest run` (`src/__tests__/sod.test.ts` + existing resolver tests). | AC-8, AC-11 |
| **FF-SOD10** | Exactly-one-row-on-pass / zero-on-deny: a guarded op passing grant∧SoD appends exactly one actor_event row (matching fields); a deny for any reason (no_grant / sod_violation / not_found) appends zero; the writer runs `validateActorEventInput` first and rejects on failure. | `vitest run` (in-memory store assertions). | AC-10, AC-13, AC-14 |
| **FF-SOD11** | Dynamic-SoD attribution: DSoD-1 self-approval blocked; DSoD-2 `approve_L1≠L2`; `COALESCE(onBehalfOf, actor)` attribution; delegated-act collision (X on_behalf_of P collides with P's submit; X self-act does not). | `vitest run` (pure `evaluateDynamicSod` over a seeded trail). | AC-4, AC-5, AC-6, AC-7, AC-12 |
| **FF-SOD12** | Static-SoD: same-principal-two-roles detection over EFFECTIVE assignments; proposal / out-of-window / non-overlapping-scope assignments do NOT count; the FR-10 standalone `wouldCreateStaticConflict` query. | `vitest run` (pure `detectStaticConflict` / `wouldCreateStaticConflict`). | AC-2, AC-3, AC-10(FR-10) |
| **FF-SOD13** | Determinism/purity: the static/dynamic decision functions called twice with identical inputs return deep-equal output (no hidden clock/random; the only async is the injected reader). | `vitest run` (call-twice deep-equal assertion). | AC-20 |
| **FF-SOD14** | `tsc --noEmit` passes after the additive `sod?:` field + widened `resolveFor` return; no `Operation` literal cast for the guarded ops. | `tsc --noEmit` (existing `npm run ci`). | AC-19 |

---

## 8. Live DDL validation (done in this DESIGN, isolated Postgres)

Validated against an isolated Postgres 16 (port 55459, own volume, torn down) with the real
migration set 001–022 applied, then the draft 027/028:

- **AC-1** — `kind = 'bogus'` rejected by the CHECK; a static row missing `role_a/role_b` rejected by
  `sod_constraint_static_shape`; valid `static` + `dynamic` rows accepted.
- **AC-15** — `relrowsecurity=t`, `relforcerowsecurity=t`; policy `sod_constraint_tenant_isolation`
  present; `choros_app` granted `INSERT,SELECT,UPDATE,DELETE`.
- **AC-16** — forward `next_seq` advance succeeds; backward `UPDATE` raises `restrict_violation` for
  BOTH `choros_migrator` (owner) and `choros_app`; the writer-path `SELECT … FOR UPDATE; UPDATE
  next_seq = next_seq + 1` passes the trigger (12 → 13).
- **AC-17** — a `choros_app` session bound to TENANT_B reads **0** of TENANT_A's `sod_constraint`
  rows (NOBYPASSRLS + FORCE RLS).
- **Regression** — `actor_event_append_only.sh` and `actor_event_no_global_seq.sh` stay PASS with the
  028 trigger staged in `migrations/`.

(The draft SQL is reproduced verbatim in §4.2/§4.3; the coder writes the final
`migrations/027_*.sql` + `028_*.sql`.)

---

## 9. Traceability (every AC → design locus)

| AC | Covered by |
|---|---|
| AC-1 closed `kind` CHECK + `SodKind` two-member type | §4.2 CHECK; §4.1 `SodKind`; FF-SOD7; live §8 |
| AC-2 static detection (two effective roles) | §4.1 `detectStaticConflict`; FF-SOD12 |
| AC-3 static respects effectiveness | `SodSource.effectiveAssignmentsOf` filter (DAO); FF-SOD12 |
| AC-4 DSoD-1 self-approval blocked | §4.1 `evaluateDynamicSod`; §4.5 step 3.6; FF-SOD11 |
| AC-5 DSoD-2 `approve_L1≠L2` | §4.1 `evaluateDynamicSod`; FF-SOD11 |
| AC-6 `on_behalf_of` attribution | `actorEventPrincipal` (T-0019); §4.5; FF-SOD11 |
| AC-7 delegated-act collision | §4.1 `evaluateDynamicSod`; FF-SOD11 |
| AC-8 step 3.6 gating | §2; §4.5; FF-SOD9 |
| AC-9 `sod_violation` reason distinct | §5; FF-SOD9 |
| AC-10 exactly-one / zero rows | §4.5 step 6.5; FF-SOD10 |
| AC-11 backward-compat (no `deps.sod`) | §2 NF-2 floor; §4.4; FF-SOD9 |
| AC-12 reader implemented (a/b/c) | §4.1 store; FF-SOD11 |
| AC-13 append-only single-INSERT writer | §4.1 store; §4.3; FF-SOD8/SOD10 |
| AC-14 `validateActorEventInput` precondition | §4.1 store bullet (b); FF-SOD10 |
| AC-15 `sod_constraint` tenant table + RLS + fixture | §4.2; FF-SOD6/SOD7; live §8 |
| AC-16 no-decrement trigger | §4.3; FF-SOD8; live §8 |
| AC-17 cross-tenant isolation | §4.2; FF-SOD6/SOD7; live §8 |
| AC-18 single-chokepoint preserved | §2; §6; FF-SOD2/SOD5 |
| AC-19 frozen surfaces + import surface + tsc | §4.4; §5; FF-SOD3/SOD4/SOD14 |
| AC-20 purity/isolation/determinism | §6; FF-SOD1/SOD13 |

---

## 10. Runtime target

**Local / container** (in-memory ports now; the Postgres DAO for `SodSource` /
`ActorEventReader` / `ActorEventWriter` lands in **T-0053** on the same single-Postgres substrate).
No new external resource, no new npm dependency (NF-4). No founder gate (GT-4) introduced.

## 11. No escalation

Not high-leverage in the product-loop sense: T-0032 reuses the T-0034 additive-step precedent and
the T-0013 tenant-table pattern verbatim; the two judgment calls (guard locus = step 3.6; writer +
FO-T0019-1 in scope; SoD read+write = one `withTenant` transaction at the DAO) were resolved against
existing precedent and recorded here, not deferred. The only scope-widening (the writer +
FO-T0019-1) is surfaced as **friction** for the orchestrator ledger.
