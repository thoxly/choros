# SPEC · T-0032 — SoD constraints (static + dynamic) as queries over the ledger; `approve`/`transition` = guarded class (E4.2)

- **Task:** T-0032 (epic E4.2, day-1, GT-1 auto-approved 2026-06-08)
- **Phase:** SPEC · role `analyst`
- **Deps (live on dev base 9409a75):** E4.1 actor_event ledger (T-0019, migration 018 + `src/core/actor-event.ts`), E3.2 role/role_assignment (T-0022, migrations 019/020/021), E2.3 grant-lattice + E2.5 gateway/PDP (T-0018/T-0021, `src/core/grant-resolver.ts`).
- **Status:** `ready` — no BLOCKING questions (see §8).

---

## 1. What we build (one sentence)

`sod_constraint(kind ∈ {static,dynamic}, role_a, role_b|self_record, scope)` rows plus a
**SoD evaluation layer expressed entirely as queries over the existing `actor_event` ledger and
`role_assignment` table** (no new derived state), wired so that `approve`/`transition` is a
**first-class guarded operation class**: every guarded op must pass the SoD check at action-time
*and* writes exactly one `actor_event` row, with both a static SoD (incompatible roles on one
object) and a dynamic SoD (same principal can't approve own request; `approve_L1 ≠ approve_L2`;
`on_behalf_of` honored) blocking the transition fail-closed.

---

## 2. Context & the frozen seams this task fills

T-0019 shipped the ledger **and froze two contracts it deliberately did not implement**
(`src/core/actor-event.ts`, ADR §4.3/§4.4, §7 "Not built here"):

- **Write contract** `ActorEventWriter.appendActorEvent` (`§4.3`) — the *guarded-transition writer*,
  tagged "T-0021/E4.2". Today only `notImplementedActorEventWriter` (a deny stub) exists.
- **Read contract** `ActorEventReader` (`§4.4`), three SoD substrate queries, tagged "T-0032/E4.2":
  - `(a) trail(ref)` — per-object ordered actor-event trail (`ORDER BY seq`);
  - `(b) didPrincipalPerform(ref, event, principal)` — dynamic-SoD substrate, matches on
    `COALESCE(on_behalf_of, actor) = principal` (the `actorEventPrincipal` rule);
  - `(c) rolesThatActed(ref, events?)` — static-SoD substrate, the distinct `role_at_event` set.

T-0032 implements **both halves of E4.2** (the SoD reader *and* the guarded-transition writer),
because the guard is one indivisible action-time step: on a guarded op the gateway must (i) read the
ledger to decide SoD, then (ii) append the actor_event row recording the act. Splitting reader from
writer would leave the guarded class with no way to record what it guarded. Owning the writer means
the **forward debt F-T0019-1 / FO-T0019-1 (no-decrement guard on `actor_event_seq`) is T-0032's**
(§3.4, AC-16) — it was explicitly handed to "the T-0021/E4.2 writer".

### 2.1 Where the SoD guard lives (architecture decision, fixed here for the architect)

The gateway is the single enforcement chokepoint (hypothesis §6-A #1; `grant-resolver.ts` is the
PDP). `resolveFor(deps, handle, subject, op, …)` is already **operation-parameterized** and `op`
already includes `approve` and `transition` (`grant-lattice.ts Operation`). T-0034 set the binding
precedent: external-effect verification was folded into `resolveFor` as an **additive "step 3.5"**
guarded by `op === "invoke"`, behind an **optional injected port** (`deps.effects`), with
backward-compat when the port is absent and the single-resolver fitness check kept green.

**Decision:** the SoD guard is the analogous **additive "step 3.6" inside the same `resolveFor`
body**, active only when `op ∈ {approve, transition}` and an optional `deps.sod` port is injected.
It is **NOT** a separate authorization module. (T-0029's scoped-admin checker is a separate module
because it authorizes *management-object* operations on a different axis — it pre-filters which
mgmt ops a scoped admin may attempt; it is not an action-time guard on record transitions. SoD is
inherently an action-time query over the per-object ledger at the transition instant, so it belongs
at the same gateway step where the covering-grant decision is made.) This preserves the
single-chokepoint and single-projection invariants and introduces no second permission subsystem.

The SoD evaluation itself lives in a **new module `src/core/sod.ts`** (the static/dynamic decision
functions + the `SodSource`/constraint-loading port + the guarded-transition writer), imported by
`grant-resolver.ts` exactly as `effect-resource.ts` is. `grant-lattice.ts`, `object-handle.ts`,
`actor-event.ts`, and migration `008_grant.sql` are **not edited**.

---

## 3. Scope

### 3.1 Static SoD — incompatible roles (queries over `role_assignment`)

A `sod_constraint(kind='static', role_a, role_b, scope)` declares that **one principal may not
simultaneously hold both `role_a` and `role_b`** within the constraint `scope`. Static SoD is a
query over **confirmed, in-window `role_assignment` rows** (the `confirmed_by IS NOT NULL` +
validity-window + `org_scope` containment rule T-0022 fixed): a static violation exists when the same
`employee_id` holds an effective assignment to `role_a` **and** an effective assignment to `role_b`
whose `org_scope`s both intersect the constraint `scope`.

Static SoD is evaluated at **two points** (both day-1):
- **Action-time** (the guarded-transition path): the acting principal's *currently-resolved* roles
  on the object are checked against every static constraint whose `scope` covers the object —
  a transition performed while holding an incompatible pair is blocked.
- **As a standalone query** (assignment-conflict detector): given a candidate `(employee, role)`
  assignment, report whether confirming it would create a static-SoD violation against the
  principal's existing effective assignments. (This is the substrate E4.6 dual-control later keys
  on; T-0032 ships the *query*, not the assignment-time block workflow — see §3.3.)

### 3.2 Dynamic SoD — over the actor-event ledger

A `sod_constraint(kind='dynamic', role_a|NULL, self_record, scope)` declares a **per-object actor
separation** evaluated over the ledger via the T-0019 read contract. Day-1 dynamic rules:

- **DSoD-1 (separation-of-duty / self-approval):** the principal who `submit`ed an object may not
  `approve` it. Evaluated as: at the moment of an `approve` transition, run
  `didPrincipalPerform(ref, 'submit', actingPrincipal)` — if true, **block**. Symmetric coverage:
  the principal performing any guarded `approve`/`transition` must not be the principal of an
  earlier conflicting verb on the same object (`request`/`prepare`/`submit`), per the constraint.
- **DSoD-2 (multi-level approval separation):** `approve_L1 ≠ approve_L2` — the principal who
  performed `approve` at level *n* may not perform `approve` at a different level *m≠n* on the same
  object. Evaluated over the trail filtered to `event='approve'`, comparing `approve_level` and
  `COALESCE(on_behalf_of, actor)`.
- **on_behalf_of is honored throughout:** SoD attribution uses the **principal** —
  `COALESCE(on_behalf_of, actor)` (`actorEventPrincipal`, T-0019 §4.4(b)/AC-12). A delegated act by
  performer `X on_behalf_of P` is attributed to `P`; a self-act to `X`. A performer acting for two
  different principals does **not** collapse them; two acts attributed to the **same principal**
  collide regardless of who physically performed them.

Dynamic SoD is a **query over the ledger** — it introduces **no new "approval state" table**; the
decision is recomputed from `actor_event` rows at action-time (TOCTOU-safe, like the grant check).

### 3.3 `approve`/`transition` as a guarded class + the writer

- A guarded op (`op ∈ {approve, transition}`) **must** traverse the SoD guard step in `resolveFor`;
  there is **no ungated path** for these ops through the gateway. When `deps.sod` is wired, the
  guard runs; when absent, the gateway degrades to pre-T-0032 behavior (backward-compatible —
  NF-2), exactly like the T-0034 effect port.
- On a guarded op that **passes** all checks (covering grant ∧ SoD), the gateway appends **exactly
  one** `actor_event` row via `appendActorEvent` recording the act (`actor`, `on_behalf_of`,
  `role_at_event`, `event`, `approve_level`). The writer is append-only (one INSERT, advancing the
  per-tenant `actor_event_seq` under `SELECT … FOR UPDATE`), per the T-0019 §4.3 contract — **no
  read-modify-write** of prior rows.
- On a **blocked** op (no grant, or SoD violation), **no** actor_event row is written (the act did
  not happen) — fail-closed, the denial is the gateway's existing `{denied:true, reason}` shape with
  a new `reason: 'sod_violation'`.

### 3.4 F-T0019-1 / FO-T0019-1 — no-decrement guard (IN SCOPE)

Because T-0032 owns the writer, it inherits FO-T0019-1: `choros_app` holds `GRANT UPDATE ON
actor_event_seq` (needed to advance `next_seq`), so as-is a caller can roll `next_seq` *backward*
into an unused lower slot and backfill a forged row that sorts `ORDER BY seq` before a committed row
— inverting apparent SoD order (e.g. `approve` before `submit`) without violating
`UNIQUE(tenant_id, seq)`. T-0032 closes it with the **preferred structural fix (option A):** a
`BEFORE UPDATE` trigger on `actor_event_seq` that raises when `NEW.next_seq < OLD.next_seq`
(decrement forbidden at the DB layer, always-on, CI-visible to defeat).

### 3.5 Migration & tenancy seam

- New table `sod_constraint` is a **T-0013 tenant table** (tenant_id-leading PK, ENABLE+FORCE RLS,
  default-DENY isolation policy on `choros.tenant_id`, DML grant to `choros_app`).
- Migration numbers start at **027** (026 is held by the in-flight T-0029; 017=T-0033, 018=T-0019,
  019–021=T-0022, 022=T-0034). T-0032 uses 027 (the `sod_constraint` table) and 028 (the
  `actor_event_seq` no-decrement trigger), in that order. *(The architect MAY collapse to a single
  migration; the run-seam requirement is only "≥027, lexicographically after 022".)*
- `sod_constraint` is added to `ci/checks/known_tenant_tables.txt`, and the cross-tenant fitness
  case (`cross_tenant.test.ts`, lesson T-0062) must cover it — a `sod_constraint` row under tenant A
  is invisible to a session bound to tenant B.

---

## 4. Functional requirements

- **FR-1:** `sod_constraint(kind ∈ {static,dynamic}, role_a, role_b|self_record, scope)` is a
  first-class per-tenant table (migration 027); `kind` is a **closed CHECK set** `{static,dynamic}`.
- **FR-2:** Static SoD is a query over **effective** (`confirmed_by IS NOT NULL` ∧ in validity-window
  ∧ `org_scope` containment) `role_assignment` rows — a violation = same `employee_id` holds both
  `role_a` and `role_b` within the constraint `scope`. No new derived state.
- **FR-3:** Dynamic SoD is a query over `actor_event` via the T-0019 read contract; attribution uses
  the principal `COALESCE(on_behalf_of, actor)` (`actorEventPrincipal`). No new approval-state table.
- **FR-4:** The T-0019 `ActorEventReader` (a/b/c) is **implemented** by T-0032 (replacing
  `notImplementedActorEventReader`) without changing the frozen port shape.
- **FR-5:** The T-0019 `ActorEventWriter.appendActorEvent` is **implemented** by T-0032 (replacing
  `notImplementedActorEventWriter`): append-only single INSERT advancing `actor_event_seq` under
  `SELECT … FOR UPDATE`; the input is validated by the existing `validateActorEventInput` first.
- **FR-6:** `resolveFor` gains an additive **step 3.6** SoD guard, active iff `op ∈ {approve,
  transition}` AND `deps.sod` is present; on a SoD violation it returns
  `{ denied: true, reason: 'sod_violation' }` (fail-closed). Absent `deps.sod` ⇒ step skipped
  (backward-compatible).
- **FR-7:** On a passing guarded op the gateway appends **exactly one** `actor_event` row; on any
  denial (no_grant / sod_violation / not_found) **zero** rows are written.
- **FR-8:** DSoD-1: a principal who `submit`ed object X cannot `approve` X (self-approval blocked).
- **FR-9:** DSoD-2: `approve_L1 ≠ approve_L2` — same principal cannot perform two distinct
  `approve_level`s on the same object.
- **FR-10:** Static-SoD standalone query: given a candidate `(employee, role)` assignment, report
  whether confirming it would create a static-SoD violation against the principal's existing
  effective assignments.
- **FR-11:** A `BEFORE UPDATE` trigger on `actor_event_seq` rejects `NEW.next_seq < OLD.next_seq`
  (FO-T0019-1 closed structurally at the DB layer).
- **FR-12:** Exports from `src/core/sod.ts`: the `SodConstraint`/`SodKind` types, the `SodSource`
  loader port, the static-SoD query, the dynamic-SoD decision functions, and the guarded-transition
  writer factory — consumable by `grant-resolver.ts` and downstream (E4.6) without re-declaration.

---

## 5. Non-functional requirements

- **NF-1:** `src/core/sod.ts` imports no `pg`/`fs`/`net`/`http`; all DB access is behind injected
  ports (`SodSource`, the T-0019 `ActorEventReader`/`ActorEventWriter`). In-memory now; the Postgres
  DAO lands in T-0053. The static/dynamic decision functions are pure (equal inputs ⇒ equal output).
- **NF-2:** `ResolverDeps.sod` is **optional**; callers without it compile unchanged and the SoD step
  is skipped (backward-compatible, mirrors `deps.effects`).
- **NF-3:** **Fail-closed** — any doubt (malformed constraint, unreadable ledger via the port,
  ambiguous attribution) resolves to **denial** of the guarded op, never to silent allow.
- **NF-4:** No new npm dependencies (zero-dep stdlib/TS posture).
- **NF-5:** Single-chokepoint preserved: the SoD guard is inside the one `resolveFor` core; no second
  handle→fields path, no second authorization subsystem; `ci/checks/single-resolver.sh` stays green.
- **NF-6:** `grant-lattice.ts`, `object-handle.ts`, `actor-event.ts` (the frozen contract shapes),
  and `migrations/008_grant.sql` are **not edited**; `grant-resolver.ts` import surface is preserved
  additively (only an optional `sod?: SodSource` on `ResolverDeps`).
- **NF-7:** Migration numbers ≥ 027 (027 = `sod_constraint`, 028 = the seq trigger); `sod_constraint`
  added to `known_tenant_tables.txt` and covered by the cross-tenant fitness case.
- **NF-8:** Append-only ledger discipline intact — the writer never UPDATE/DELETEs `actor_event`;
  the T-0019 immutability triggers and `choros_app` `SELECT,INSERT`-only grant are unchanged.

---

## 6. Out of scope (explicit non-goals)

- The **assignment-time block workflow** (refusing to *confirm* a conflicting assignment) and the
  E4.6 dual-control gate — T-0032 ships the static-SoD *query* (FR-10); enforcing it on the
  assignment write-path is E4.6 (T-0039/dual-control). T-0032 enforces SoD only on the
  `approve`/`transition` action-time path.
- `role_criticality` computation (E4.5 / T-0040) and `confirmation_flag` (E4.6 / T-0039).
- The **Postgres DAO** for `SodSource`/`ActorEventReader`/`ActorEventWriter` — deferred to T-0053
  (this task ships the ports + in-memory implementations + the migrations only).
- BPMN/engine wiring of the guarded class into Flowable transitions (the engine-side caller) —
  T-0032 delivers the gateway guard + writer; the engine state-mutation guard (T-0028) is the caller
  and is not re-specified here.
- Editing `grant-lattice.ts`, `object-handle.ts`, `actor-event.ts`, or `migrations/008_grant.sql`.
- Substitutions/absences SoD interactions (E4.7 / T-0035).
- Any new approval-state or SoD-cache table (SoD is queries-only by construction).

---

## 7. Acceptance criteria (machine-checkable)

See `docs/specs/T-0032.spec.contract.json` (the schema-validated handoff). Summary:

- **Static SoD** (AC-1..AC-3): closed `kind`; same-principal-two-roles detection; standalone
  conflict query.
- **Dynamic SoD** (AC-4..AC-7): self-approval block; `approve_L1≠L2`; `on_behalf_of` attribution;
  delegated-act collision.
- **Guarded class** (AC-8..AC-11): SoD step gated on `op∈{approve,transition}`; `sod_violation`
  reason; exactly-one-row-on-pass / zero-on-deny; backward-compat when `deps.sod` absent.
- **Reader/writer impl** (AC-12..AC-14): the three read queries; append-only single-INSERT writer;
  `validateActorEventInput` precondition.
- **DB/tenancy/debt** (AC-15..AC-18): `sod_constraint` tenant table + RLS + known_tenant_tables;
  cross-tenant isolation; FO-T0019-1 no-decrement trigger; isolation/single-resolver fitness green.
- **Frozen surfaces** (AC-19..AC-20): import-surface + frozen-files fitness; determinism/purity.

---

## 8. BLOCKING questions

**None.** The scope is fully determined by the E4.2 backlog entry, the hypothesis (§3 Q4, §5,
§6-A #4), the frozen T-0019 read/write contracts, and the T-0022 effective-assignment rule. The two
judgment calls were resolved against existing precedent and recorded as decisions, not questions:

1. *Where the SoD guard lives* — resolved to "step 3.6 inside `resolveFor`" by the T-0034 precedent
   and the single-chokepoint invariant (§2.1), not a separate module à la T-0029.
2. *Whether the writer + FO-T0019-1 are in T-0032's scope* — resolved **yes** (§2, §3.4): the
   guarded class cannot record its act without the writer, and the writer's perimeter debt is
   therefore T-0032's. This widens T-0032 beyond a pure reader, but honestly per the backlog
   ("`approve`/`transition` = first-class guarded class" is E4.2, and the writer was tagged
   "T-0021/E4.2" with no T-0021 ownership of it — T-0021 shipped only the read-path PDP).

Surfaced as **friction** (not blocking) for the orchestrator's ledger, since it expands the task's
effective surface relative to a naive "implement the 3 reader stubs" reading.
