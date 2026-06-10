# ADR · T-0019 — Typed actor-event ledger per object (the SoD source of truth)

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-06-10
**Spec:** `docs/specs/T-0019-actor-event-ledger.spec.md` (status: ready, AC-1..AC-22) · `docs/specs/T-0019.spec.contract.json`
**Foundation (do NOT contradict):** `docs/design/T-0013-tenant-isolation.adr.md` (`actor_event` is an ordinary FORCE-RLS default-DENY tenant table accessed via `withTenant` + the `choros.tenant_id` GUC) · `docs/design/T-0016-audit-floor.adr.md` (the append-only dual-mechanism posture this ledger reuses; the boundary §2 fixes) · `docs/design/T-0017-org-structure.adr.md` (`employee` exists → `actor`/`on_behalf_of` FKs are buildable today; `kind∈{human,agent}` is **not** an SoD discriminator) · `migrations/006_audit_event.sql`, `008_grant.sql`, `009_object_handle.sql`, `016_employee.sql` (the **real** baseline DDL this migration extends).
**Backlog/hypothesis:** `playbooks/rbac-backlog.md#E4.1` · hypothesis §5 (`actor_event`), §3 Q4, §6-A #4 (GT-1 signed 2026-06-08).

> This ADR is a **REAL migration** design, not design-only. Postgres is **live** on this
> base (migrations 001–016 applied on dev `a90f78d`; T-0053 done). T-0019 emits
> **`migrations/018_actor_event.sql`** (017 is **reserved** for the parallel T-0033 and MUST
> NOT be used) plus the additive `ci/checks/known_tenant_tables.txt` entry. It fixes the
> *invariants, object model, contracts, and fitness functions* any correct implementation
> MUST satisfy; the **coder** writes the SQL/triggers/grants/indexes and the frozen
> contracts' fixtures.
>
> T-0019 does **not** implement the writer (`appendActorEvent` / the guarded-transition
> class — **T-0021/E4.2**) nor the SoD query layer (**T-0032/E4.2**). It freezes their
> seams (§4.3 write contract, §4.4 read contract) as the single source of truth those tasks
> consume.
>
> Each fitness function carries a concrete `ci_check` and a gating note: **static-now** =
> runs in today's `npm run ci` (tsc/eslint/vitest + `ci/checks/*` shell lints; repo is
> zero-runtime-dep); **live-DB** = a live-Postgres probe wired into `fitness:db`
> (`vitest run --dir ci/checks/db`) / the migration CI job. This mirrors T-0016/T-0017.

---

## 1. Decision (one paragraph)

One append-only, per-tenant **`actor_event`** tenant table (migration 018) is the SoD
substrate. It is an ordinary T-0013 tenant table (`tenant_id` NOT NULL **leading PK**,
`ENABLE`+`FORCE` RLS, one default-DENY policy on `choros.tenant_id`, `choros_app`
NOBYPASSRLS, all access via `withTenant`) — that convention is inherited **verbatim**, not
re-derived. On top of it, six structural decisions (§3) hold: **(1)** append-only by the
**same dual mechanism as `audit_event`** (`choros_app` granted `SELECT,INSERT` only **and** a
`BEFORE UPDATE`/`BEFORE DELETE` no-mutate trigger that raises for **all** roles incl. the
owner); **(2)** a per-tenant **strictly-increasing** `seq` (`UNIQUE`/PK `(tenant_id, seq)`)
assigned under a **per-tenant counter row** `actor_event_seq` locked `FOR UPDATE` — never a
global sequence/lock, sparse-tolerant (no density requirement); **(3)** actor identity that
splits **performer** (`actor` = `performed_by`, NOT NULL, FK→`employee`) from **principal**
(`on_behalf_of`, nullable, FK→`employee`), with SoD attributing to
`COALESCE(on_behalf_of, actor)`, plus `role_at_event` (NOT NULL, point-in-time `role_id`, **no
FK**, deferred to T-0022); **(4)** an `object_ref` that is a **denormalized opaque
ResourceRef** à la `object_handle` (`object_kind` CHECK + nullable, non-FK component ids),
index-served per object; **(5)** a **closed, vocab-versioned** verb set (`event` CHECK over the
five GT-1 verbs; `approve_Ln` = `event='approve'` + `approve_level smallint`); **(6)**
**references-not-values** (no payload column; only a `detail jsonb` of event metadata). The
ledger is intentionally **not** the audit floor: **no** hash chain, **no** head, **no** FK to
`audit_event`. A guarded transition writes one `actor_event` row **and** one `audit_event`
row in distinct tables (optionally cross-referenced by the stable `actor_event.id`); coupling
them is the writer's job (T-0021/E4.2), not T-0019's.

---

## 2. The boundary T-0019 makes unambiguous — ledger vs audit floor

`actor_event` (T-0019) and `audit_event` (T-0016) are **both** append-only tenant tables but
are different ledgers with different jobs:

| | `actor_event` (T-0019) | `audit_event` (T-0016) |
|---|---|---|
| Purpose | typed **SoD substrate**: ordered actor-verbs per object | tamper-evident **governance audit** |
| Keyed by | `object_ref` (verbs accumulate per object) | `tenant_seq` (per-tenant chain position) |
| Verbs | **closed** `{request,prepare,submit,approve,release}` | **open** `type` string |
| Integrity | append-only; **no hash chain, no head** | append-only **+ per-tenant hash chain + head** |
| `on_behalf_of` | **first-class column** (SoD sees delegation) | via `proposed_by`/`confirmed_by`/`subject` |

A guarded transition (E4.2) writes **one `actor_event` row** (the SoD fact) **and one
`audit_event` row** (the tamper-evident fact). The `audit_event` row **MAY** carry the
`actor_event.id` uuid to cross-reference, but there is **NO enforced FK** between the two
ledgers — each is independently append-only (AC-21/AC-22). T-0019 fixes only that both rows
exist, are distinct, and neither subsumes the other. Hash-chaining `actor_event` would
**duplicate** the audit floor and require a head table AC-21 forbids — see §5 rejected.

---

## 3. The six structural decisions

### 3.1 Append-only by a dual mechanism (FR-1, NF-2) — mirrors T-0016

Two orthogonal guards are held **simultaneously**, exactly as `audit_event`
(`migrations/006`):

- **(a) privilege guard:** `GRANT SELECT, INSERT ON choros.actor_event TO choros_app;` — **no
  `UPDATE`/`DELETE`**.
- **(b) no-mutate trigger:** `CREATE FUNCTION choros.actor_event_immutable()` that
  `RAISE EXCEPTION ... USING ERRCODE='restrict_violation'`, fired by `BEFORE UPDATE` and
  `BEFORE DELETE` triggers — for **all** roles, including the owner `choros_migrator`
  (defence in depth: append-only survives an app-role privilege misconfiguration).

Defeating append-only requires a **CI-visible** diff that **both** grants the privilege **and**
drops/disables the trigger — never a forgotten runtime guard. *Rationale:* a silently edited
`submit`/`approve` row would let an actor approve their own work, evading SoD. The static lint
`ci/checks/actor_event_append_only.sh` (modelled on the existing `audit_append_only.sh`)
asserts (a) no `UPDATE`/`DELETE` grant to `choros_app` on `actor_event` and (b) the no-mutate
trigger is present (FF-4 / AC-4..7).

### 3.2 Per-tenant ordering via a counter row, never global (FR-5, NF-2)

Every row carries `ts bigint NOT NULL` (epoch-ms wall clock) and `seq bigint NOT NULL`, a
**per-tenant strictly-increasing** ordinal with `UNIQUE (tenant_id, seq)` and PK
`(tenant_id, seq)`. **SoD order reasoning ("submit *before* approve") uses `seq`, never `ts`**
(clocks tie/skew).

The serialization primitive is a **per-tenant counter row**:

```sql
CREATE TABLE choros.actor_event_seq (
  tenant_id uuid   NOT NULL PRIMARY KEY,
  next_seq  bigint NOT NULL DEFAULT 1
);  -- FORCE-RLS default-DENY like every tenant table; GRANT SELECT,INSERT,UPDATE (no DELETE)
```

The append path does `INSERT ... ON CONFLICT(tenant_id) DO NOTHING; SELECT next_seq ... FOR
UPDATE; seq := next_seq; UPDATE ... SET next_seq = next_seq + 1` — per-tenant, race-free, no
global contention point. This mirrors T-0016's "lock the row you must read anyway" pattern
**without** being a head/chain artefact (it carries only a counter — no `row_hash`, no chain),
so AC-21's "no head table" holds. `seq` is **sparse-tolerant**: strictly-increasing is
sufficient for total order; density (T-0016's +1) is **not** required here because there is no
chain whose gaps signal deletion (§5 rejected). `ci/checks/actor_event_no_global_seq.sh`
asserts the primitive is per-tenant (counter row `FOR UPDATE`, *or* a per-tenant advisory
lock) and fails on a global `SEQUENCE`/non-tenant-keyed advisory lock (FF-6 / AC-9).

### 3.3 Performer ≠ principal; role at event-time; human=agent (FR-2, NF-3)

- `actor uuid NOT NULL` = **who physically performed**; FK `(tenant_id, actor) →
  employee(tenant_id, id)` (tenant-scoped both sides; buildable today per T-0017).
- `on_behalf_of uuid NULL` = the **principal** when ≠ performer (delegation/substitution,
  E4.7); FK→`employee`; **`NULL` ⇒ acted on own behalf**. SoD attributes to the principal
  `COALESCE(on_behalf_of, actor)` so a delegated approval still counts against the principal
  for the same-person check (FF-8 / AC-11/12).
- `role_at_event uuid NOT NULL` = the **point-in-time** `role_id` the actor acted under (not
  current roles). It carries **no FK** — `role` is undesigned (T-0022/E3.2); a baseline FK to
  a non-existent table would fail to apply. This is the **exact precedent of `grant.role_id`**
  in `008_grant.sql` (plain NOT NULL uuid, FK deferred). T-0022's migration adds the FK.
  AC-14 requires a non-existent `role_at_event` uuid to be **accepted** today.
- `kind ∈ {human,agent}` is **NOT** a column of, or a discriminator in, `actor_event`: a human
  and an agent are **equal actors** for SoD (an agent that `submit`s then `approve`s is a
  violation exactly as a human). `kind` is resolvable by joining `employee` — distinguishable
  but never privileged. FF-9/AC-13 lints that no `kind` column exists.

### 3.4 `object_ref`: a denormalized, non-FK ResourceRef (FR-3) — mirrors `object_handle`

Each row anchors to **the object the actor acted on** via the T-0015 opaque-pointer pattern
(`009_object_handle.sql`):

- `object_kind text NOT NULL CHECK (object_kind IN ('application','registry','record'))`
  (mirrors `object_handle.ref_kind`), plus nullable `application_id`/`registry_id`/`record_id`
  — **none FK-enforced** (handles/records may be referenced before/without a hard FK and
  across the gateway; AC-15 requires a `record_id` absent from `record` to be accepted).
- The set of component ids populated is determined by `object_kind` (record→`record_id`,
  etc.). **Object-scoped lookup is the primary read path** — *"all events for object X,
  ordered"* — served by `INDEX (tenant_id, object_kind, record_id, registry_id,
  application_id, seq)` (tenant_id leading per AC-3; trailing `seq` so the per-object trail is
  index-ordered, FF-12/AC-16: EXPLAIN shows an index scan).

### 3.5 Closed, level-typed, vocab-versioned verbs (FR-4, §4.2)

- `event text NOT NULL CHECK (event IN ('request','prepare','submit','approve','release'))` —
  the **closed** GT-1-signed set, **not** an open string. SoD queries reason over a known
  finite verb alphabet; an open verb would let an un-reviewed verb silently escape SoD
  coverage.
- `approve_Ln` is `event='approve'` + `approve_level smallint`, **not** N verb strings, with
  `CHECK ((event='approve') = (approve_level IS NOT NULL))` (level non-null **iff** approve)
  and `CHECK (approve_level IS NULL OR approve_level >= 1)`. Levels are distinguishable and
  **orderable** (L1<L2<… for multi-step chains) while the verb set stays finite.
- `vocab_version smallint NOT NULL` pins the verb set + level semantics per row. **Extending
  the set is a CHECK edit + `vocab_version` bump** (deliberate, CI-visible) — never a runtime
  free string. `ci/checks/actor_event_vocab_pinned.sh` (or a unit golden) fails CI if the set
  changes without a bump (FF-16/AC-20).

### 3.6 References, not values (FR-6, NF-4)

`actor_event` carries **no** `data`/`snapshot`/`view`/`payload` column — only the `object_ref`
(a pointer) and the actor/role identities. The **gateway (T-0021) remains the sole
object-value resolver** (mirrors `object_handle`'s "names fields, never values"). A single
`detail jsonb NULL` MAY carry verb-specific **event metadata** (a `from→to` state id, an
approval-comment reference) **provided it holds no object field values**. FF-13/AC-17 lints
that the only `jsonb` is `detail` and no payload column exists.

---

## 4. Object model and contracts (the source of truth for `coder`)

> Postgres types are authoritative; the TS mirror follows the T-0014/T-0017 convention
> (camelCase, `string` for `uuid`, `number` for `bigint` epoch-ms). T-0013 §3.1 (tenant_id
> NOT NULL leading PK, FORCE RLS, default-DENY, `withTenant`) is inherited verbatim and not
> restated per-field.

### 4.1 `actor_event` (migration 018)

| Field | Type | Constraints / Notes |
|---|---|---|
| `tenant_id` | `uuid` | NOT NULL; **leading PK column**; RLS key |
| `seq` | `bigint` | NOT NULL; per-tenant **strictly-increasing** (sparse-tolerant); PK `(tenant_id, seq)`; `UNIQUE (tenant_id, seq)` |
| `id` | `uuid` | NOT NULL; stable identity; `UNIQUE (tenant_id, id)`; `uuidv7` (time-ordered); **no** FK to `audit_event` |
| `object_kind` | `text` | NOT NULL; `CHECK (object_kind IN ('application','registry','record'))` |
| `application_id` | `uuid` | NULL; ResourceRef component, **no FK** |
| `registry_id` | `uuid` | NULL; ResourceRef component, **no FK** |
| `record_id` | `uuid` | NULL; ResourceRef component, **no FK** |
| `actor` | `uuid` | NOT NULL; = `performed_by`; FK `(tenant_id, actor) → employee(tenant_id, id)` |
| `on_behalf_of` | `uuid` | NULL; principal when ≠ performer; FK `(tenant_id, on_behalf_of) → employee`; `NULL` ⇒ own behalf |
| `role_at_event` | `uuid` | NOT NULL; point-in-time `role_id`; **no FK** (deferred T-0022, mirrors `grant.role_id`) |
| `event` | `text` | NOT NULL; `CHECK (event IN ('request','prepare','submit','approve','release'))` |
| `approve_level` | `smallint` | NULL; `CHECK ((event='approve') = (approve_level IS NOT NULL))` AND `CHECK (approve_level IS NULL OR approve_level >= 1)` |
| `detail` | `jsonb` | NULL; event metadata only — **no object field values** |
| `ts` | `bigint` | NOT NULL; unix epoch ms (wall clock) |
| `vocab_version` | `smallint` | NOT NULL; pins verb set + level semantics |

- **PK** `(tenant_id, seq)`. **Object read index** `(tenant_id, object_kind, record_id,
  registry_id, application_id, seq)`. **Grants** `choros_app`: `SELECT, INSERT` only. **No-mutate
  trigger** `BEFORE UPDATE`/`BEFORE DELETE` for all roles. **RLS** ENABLE+FORCE, one
  default-DENY policy on the `choros.tenant_id` GUC.

### 4.2 `actor_event_seq` (per-tenant ordinal counter)

| Field | Type | Constraints / Notes |
|---|---|---|
| `tenant_id` | `uuid` | NOT NULL **PRIMARY KEY** — one counter row per tenant; RLS key |
| `next_seq` | `bigint` | NOT NULL DEFAULT 1; advanced under `SELECT … FOR UPDATE` in the append path |

FORCE-RLS default-DENY like every tenant table. `choros_app`: `SELECT, INSERT, UPDATE` (no
DELETE). **Not** a head/chain artefact — a bare cursor (no `row_hash`), so AC-21 holds.

### 4.3 Write contract — `appendActorEvent` (frozen; implemented by T-0021/E4.2)

```ts
// The ONLY sanctioned writer (FR-7). Runs inside withTenant (T-0013), called by the
// guarded-transition / gateway path at ACTION-TIME. Append-only INSERT.
function appendActorEvent(tx, e: ActorEventInput): { seq, id } {
  // 1. Per-tenant serialization for the ordinal (per-tenant counter row; NO global lock).
  tx.exec(`INSERT INTO actor_event_seq(tenant_id, next_seq) VALUES (TENANT, 1)
           ON CONFLICT (tenant_id) DO NOTHING`);
  const seq = tx.one(`SELECT next_seq FROM actor_event_seq
                      WHERE tenant_id = TENANT FOR UPDATE`).next_seq;
  tx.exec(`UPDATE actor_event_seq SET next_seq = next_seq + 1 WHERE tenant_id = TENANT`);
  // 2. Append exactly one row (INSERT only — never a read-modify-write of prior rows).
  const id = uuidv7();
  tx.insert("actor_event", {
    tenant_id: TENANT, seq, id,
    object_kind: e.objectKind, application_id: e.applicationId,
    registry_id: e.registryId, record_id: e.recordId,
    actor: e.actor, on_behalf_of: e.onBehalfOf ?? null,
    role_at_event: e.roleAtEvent, event: e.event,
    approve_level: e.event === "approve" ? e.approveLevel : null,
    detail: e.detail ?? null, ts: nowMs(), vocab_version: VOCAB,
  });
  return { seq, id };
}
// RETRY: on the genesis seq race (two appends both compute seq=1) one aborts on
// UNIQUE(tenant_id,seq)/serialization and MUST re-run from step 1 (re-read next_seq under
// FOR UPDATE) — a stale seq is never reused. After genesis the FOR UPDATE serializes.
// INVARIANTS: app role SELECT,INSERT only; no-mutate trigger bars UPDATE/DELETE for all
// roles; never a read-modify-write of prior rows.
```

`ActorEventInput` (TS mirror): `{ objectKind: 'application'|'registry'|'record';
applicationId?: string; registryId?: string; recordId?: string; actor: string; onBehalfOf?:
string|null; roleAtEvent: string; event: 'request'|'prepare'|'submit'|'approve'|'release';
approveLevel?: number; detail?: Record<string,unknown>|null }`. Validation: `approveLevel`
required **iff** `event==='approve'` and ≥1; exactly the component(s) implied by `objectKind`
populated.

### 4.4 Read contract — SoD substrate (frozen; consumed by T-0032/E4.2)

All run under the actor's tenant RLS context (`withTenant`). These are **read shapes**, not the
SoD constraints (those are T-0032/E4.2):

```ts
// (a) per-object ordered trail (index-served via the object_read index)
//     SELECT * FROM actor_event WHERE tenant_id=GUC AND object_kind=$k AND <comp_id>=$id
//       ORDER BY seq;
selectOrderedBySeq("actor_event", whereObject(ref));

// (b) dynamic-SoD substrate: did principal P perform event E on object X?
//     principal = COALESCE(on_behalf_of, actor) so delegated acts attribute to the principal.
//     SELECT EXISTS(... WHERE <object predicate> AND event=$E
//                        AND COALESCE(on_behalf_of, actor) = $P);
existsActorEvent(whereObject(ref), { event: E, principal: P });

// (c) static-SoD substrate: which roles acted on object X? (reads role_at_event)
//     SELECT DISTINCT role_at_event FROM actor_event WHERE <object predicate>
//       [AND event = ANY($events)];
selectDistinct("role_at_event", whereObject(ref), { events: [...] });
```

### 4.5 Structural enforcement (migration 018 SQL — built by `coder`)

(A) `GRANT SELECT,INSERT ON actor_event TO choros_app` (no UPDATE/DELETE) + `GRANT
SELECT,INSERT,UPDATE ON actor_event_seq TO choros_app` (no DELETE). (B) `actor_event_immutable()`
+ `BEFORE UPDATE`/`BEFORE DELETE` triggers for all roles. (A)+(B) held simultaneously. (C) the
verb CHECK, the `approve_level` IFF CHECK, the `object_kind` CHECK, and the FORCE-RLS
default-DENY policy are DDL constraints — not runtime guards.

---

## 5. Rejected alternatives

1. **Reuse / add a head row (`audit_head`-style) as the seq point** — a head is the construct
   AC-21 forbids; `actor_event` has no chain so a head would carry only a counter. A bare
   `actor_event_seq` cursor (no `row_hash`) gives the same per-tenant `FOR UPDATE`
   serialization without being a head/chain artefact.
2. **Per-tenant advisory lock as the seq primitive (no extra table)** — viable, but advisory
   keys share one global int8 space, so a `hashtext` collision reintroduces cross-tenant
   contention (the precise reason T-0016 rejected advisory locks). The counter row keys
   serialization exactly on `tenant_id`. *Acceptable fallback if the counter row is later
   judged heavy: an advisory lock keyed on the full tenant uuid.*
3. **Global `SEQUENCE` / one global advisory lock** — couples every tenant's write throughput
   onto one contention point (NF-2) and makes `seq` tenant-global, breaking the "tenants order
   independently" guarantee (AC-8). Caught by `actor_event_no_global_seq.sh`.
4. **Dense +1 `seq` (mirror T-0016)** — density exists in T-0016 only because a gap signals a
   deleted chain row. `actor_event` has no chain; strictly-increasing is sufficient and
   density would over-constrain serialization for no SoD benefit (FR-5 permits sparse).
5. **Hash-chain / head-snapshot the ledger** — duplicates the audit floor (§2) and forces a
   head AC-21 forbids; append-only already makes a row un-rewritable without a CI-visible diff.
6. **`approve_L1..approve_Ln` as N verb strings** — unbounds the alphabet and re-couples "add a
   level" to a CHECK migration. `event='approve'` + `approve_level` keeps the set finite and
   levels orderable.
7. **Open verb string (no CHECK)** — would let an un-reviewed verb escape SoD coverage; closed
   CHECK + `vocab_version` is the GT-1-signed safe default.
8. **FK from `role_at_event` to `role` now** — `role` is undesigned (T-0022); a baseline FK
   would fail to apply (the `grant.role_id` lesson). AC-14 requires a non-existent role uuid to
   be accepted today.
9. **FK-enforce the `object_ref` component ids** — `object_handle` fixed them as denormalized
   non-FK; AC-15 requires a `record_id` absent from `record` to be accepted (opaque-pointer).
10. **A record/object payload or snapshot column** — violates FR-6/NF-4; the gateway is the
    sole value-resolver. Only `detail jsonb` (event metadata, no object values) is permitted.
11. **A `kind` column / kind branch** — violates NF-3; SoD treats human and agent as equal
    actors; `kind` is resolvable by joining `employee`, never a discriminator here.

---

## 6. Traceability (AC → design)

| AC | Covered by |
|---|---|
| AC-1 | §4.1 RLS + additive `known_tenant_tables.txt` (FF-1) |
| AC-2 | T-0013 inheritance + `cross_tenant.test.ts` over `KNOWN_TENANT_TABLES` (FF-2) |
| AC-3 | PK `(tenant_id,seq)` + object index + employee FKs all tenant_id-leading; `tenant_id_leading.sql` (FF-3) |
| AC-4/5/6 | §3.1 dual mechanism: `choros_app` SELECT,INSERT only + no-mutate trigger for all roles (FF-4) |
| AC-7 | §4.5 (A)+(B) + `actor_event_append_only.sh` (FF-4) |
| AC-8 | PK/UNIQUE `(tenant_id,seq)` + per-tenant counter (FF-5) |
| AC-9 | §3.2 per-tenant counter `FOR UPDATE` (not global) + `actor_event_no_global_seq.sh` (FF-6) |
| AC-10 | `actor` NOT NULL FK→employee (FF-7) |
| AC-11 | `on_behalf_of` nullable FK→employee, distinct from actor (FF-8) |
| AC-12 | §4.4(b) `COALESCE(on_behalf_of, actor)` principal rule (FF-8) |
| AC-13 | §3.3 no `kind` column / no kind branch (FF-9) |
| AC-14 | `role_at_event` NOT NULL, no FK (deferred T-0022) (FF-10) |
| AC-15 | §3.4 denormalized non-FK ResourceRef + `object_kind` CHECK (FF-11) |
| AC-16 | object read index `(…,seq)` + ORDER BY seq (FF-12) |
| AC-17 | §3.6 no payload column, only `detail` jsonb (FF-13) |
| AC-18 | §3.5 closed `event` CHECK (five verbs) (FF-14) |
| AC-19 | §3.5 `approve_level` IFF CHECK + ≥1 (FF-15) |
| AC-20 | §3.5 `vocab_version` pin + `actor_event_vocab_pinned.sh` golden (FF-16) |
| AC-21 | §2 no chain/head, no FK between ledgers (FF-17) |
| AC-22 | §2 one `actor_event` + one `audit_event`, optional uuid reference, no FK (FF-18) |

---

## 7. Runtime / deploy target & run seam

**Runtime:** Postgres in the silo docker-compose stack (one tenant/instance) on the founder
home server (`/srv/choros`, deploy founder-gated) — same target as T-0013/14/16/17. Postgres
is **live** on this base, so this is a real migration. App connects as `choros_app`
(NOSUPERUSER/NOBYPASSRLS/non-owner; `SELECT,INSERT` on `actor_event`; `SELECT,INSERT,UPDATE` on
`actor_event_seq`); migrations as `choros_migrator`. **No new infra/server/DB provisioning is
introduced** (it consumes T-0053's), so **no founder GT-4 gate** is triggered.

**Run seam (frozen, NF-5):** the migration is **`018_actor_event.sql`**; **017 is reserved for
the parallel T-0033 and MUST NOT be used.** `migrations/run.mjs` sorts lexicographically by the
`NNN` prefix, so 018 applies after 016 (`employee`) and the `actor`/`on_behalf_of` FK target
exists. `ci/checks/known_tenant_tables.txt` gains `actor_event` (and `actor_event_seq`)
**additively** — the only shared-file mutation; the orchestrator merges parallel additions.

**Parallel-work reconciliation (FE-0006/0007):** T-0033 is in flight editing
`src/core/grant-resolver.ts` **additively**. T-0019's writer is designed as a **separate
module** (`src/core/actor-event.ts`, the `appendActorEvent`/read-contract port), **not** a patch
to `grant-resolver.ts`, so there is **no merge conflict** on the resolver. Both tasks append to
`migrations/` (T-0033 → 017, T-0019 → 018) and to `known_tenant_tables.txt` additively — the
run seam is non-overlapping by construction.

**Not built here (frozen contracts):** the writer (`appendActorEvent` / guarded-transition
class — T-0021/E4.2) and the SoD query layer (`sod_constraint`, static/dynamic decision,
action-time block — T-0032/E4.2). T-0019 freezes §4.3/§4.4 and implements neither.
